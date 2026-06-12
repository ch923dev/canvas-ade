# Research — Orchestrator Harness ("visible agent teams")

> **Status:** research / proposal (no code). **Date:** 2026-06-05. **Scope:** a feature where Terminal
> boards communicate, an **orchestrator** agent decomposes work, spawns role-specialized worker
> terminals (UI / backend / security), builds a plan on a **Planning board**, and dispatches prompts
> to workers — **all visible on the canvas** ("like Claude's agent teams, but visible").
>
> **Relationship to existing docs:** this **extends** `docs/roadmap-mcp.md` (the `canvas-ade-mcp` swarm
> roadmap M0–M10). It does **not** replace it. It adds four net-new bundles (H0–H4) on top of the
> already-shipped M0–M4 and sequences them against the still-unbuilt M5–M10. Sibling source of truth
> for landed state: `docs/reviews/2026-06-05-mcp-indepth-review.md`.

---

## TL;DR

- **~70% of this is already designed and ~half is already shipped.** The "agent harness" the user
  describes **is** the `canvas-ade-mcp` swarm layer. **M0–M4 are merged to `main`** (PR #43, verified
  healthy 2026-06-05 — no open Crit/High/Med). The orchestrator can already spawn boards, dispatch
  prompts terminal→terminal, relay along a drawn cable, interrupt, read board state, and read project
  memory — all behind a server-enforced token tier + fail-closed human-confirm + audit log.
- **Four things are NOT built, and they are exactly the user's vision:** ① an orchestrator
  **skill/playbook** (the package literally ships `prompts/index.ts` = *"no prompts yet"*), ② a way to
  **write the plan onto a Planning board** from MCP, ③ **roles** (UI/backend/security), and ④ **agent
  bootstrap** — `spawn_board(prompt)` is parsed but never launches a wired CLI agent, and no
  `.mcp.json`+token is written so a spawned `claude`/`codex` auto-connects. Without ④ the swarm is not
  drivable end-to-end by a real agent.
- **The market white space is real and unclaimed.** Tools either have **no AI orchestrator** (human
  drives — Maestri, Conductor, Claude Squad, vibe-kanban, Sculptor) or have one that is **completely
  hidden** (Factory, Warp/Oz, Devin, GitHub `/fleet`, Ruflo, and **Claude Code Agent Teams** — which
  is CLI/tmux-only). **Nobody ships a *visible* AI orchestrator that composes a prompt, dispatches it
  to a *named live worker terminal*, and shows the worker's output streaming back next to a shared
  planning board.** That is precisely Canvas ADE's pitch.
- **Where orchestrator knowledge lives is decided by the research:** a **Claude Code Skill**
  (`.claude/skills/canvas-orchestrate/SKILL.md` + `ROLES.md`). Progressive disclosure → ~free until
  invoked; auto-triggers on "orchestrate this". CLAUDE.md holds only always-on MCP facts; an MCP-prompt
  is too weak for a multi-step playbook; subagent-defs are the home for the *worker roles*, not the
  *strategy*.
- **Decisions taken with the user (2026-06-05 brainstorm):** support **both** orchestrator models
  (agent-in-a-terminal AND the desktop brain) via one shared adapter · build the **full phased plan**
  (4 bundles + M5–M10) · adopt **tiered + session-scoped confirmation** (needs a new ADR — touches the
  locked lethal-trifecta safety contract).

---

## 1. In-depth review — current state

### 1.1 What is LANDED and wired on `main` (M0–M4 + M5-PR1)

Source: two independent adversarial code-reads (`docs/reviews/2026-06-05-mcp-indepth-review.md`) +
direct read of `Z:\canvas-ade-mcp\src` and `Z:\Canvas ADE\src\main`.

| Capability | Tool / surface | File evidence | State |
|---|---|---|---|
| Spawn a board (terminal / browser / **planning**) | `spawn_board(type, prompt?, cwd?)` | `mcpOrchestrator.ts:219-298`; `SPAWNABLE_BOARD_TYPES` incl. `planning` | ✅ — but `prompt` param **ignored** |
| Prompt → another terminal, **blocking** (await idle, return result) | `handoff_prompt` | `mcpOrchestrator.ts:455-595` (10-step guarded; event-driven await-idle) | ✅ |
| Prompt → terminal, **fire-and-forget** | `assign_prompt` / `dispatchPrompt` | `mcpOrchestrator.ts:596-710` | ✅ |
| **A→B along a drawn cable** (the connector = authorization) | `relay_prompt` | `mcpOrchestrator.ts:722-865` (TOCTOU re-check, BUG-021) | ✅ |
| Stop a runaway worker | `interrupt` | `mcpOrchestrator.ts:866-958` | ✅ |
| Worker reports its own result | `write_result` | `mcpOrchestrator.ts:711-721` | ✅ |
| Reconfigure a board (shell / launchCommand / cwd) | `configure_board` | `mcpOrchestrator.ts:365-454` (sanitize → confirm → audit) | ✅ |
| Agent "eyes" — read-only state | resources: `canvas://boards`, `board/{id}/status`, `board-states`, `attention`, `board/{id}/output` (25k-capped, paginated), `board/{id}/result`, `memory` | `Z:\canvas-ade-mcp\src\resources\*` | ✅ |
| "All terminals know the project" | `canvas://memory` + `<project>/.canvas/memory/` (`MEMORY.md` index, `project.md`, `board-<id>.md`); Tier-1 heuristic digest (instant) + Tier-2 LLM summary (45s debounce) | `canvasMemory.ts`, `summaryLoop.ts`, `digest.ts`, `boardMemory.ts` | ✅ |
| Concurrency safety | spawn cap + idle-reap (TTL) | `mcpOrchestrator.ts:315-364` | ✅ |
| Trust boundary | orchestrator/worker **token tiers** (server registers only the tier's tools; boardId re-derived from bearer, unspoofable) | `mcp.ts:22-64`; pkg `auth/`, `server/factory.ts` | ✅ |
| Dispatch safety | opaque-id resolve → terminal-only → `sanitizeDispatchText` (reject CR/LF + C0) → single-use nonce → **fail-closed human confirm** → audit → PTY write | `mcpOrchestrator.ts`, `mcpConfirm.ts`, `auditLog.ts` | ✅ |
| Network safety | loopback-only + Host-header DNS-rebind guard + Origin + bearer | pkg `security/host.ts`, `security/origin.ts`; ADR `0003` | ✅ |
| MAIN→renderer command channel | `mcp:command` (`ping` / `addBoard` / `removeBoard` / `configureBoard`) | `mcpCommand.ts`, `useMcpCommands.ts` | ✅ |
| renderer→MAIN board mirror + per-board status subscribe | `mcp:boards` | `boardRegistry.ts:231-246` | ✅ |
| Wait efficiently | M5 barriers (`wait_for_idle`/`wait_for_all`, SSE attention) | pkg roadmap Phase 5 | 🔶 in progress (event source PR merged) |

**Net:** the dangerous half (dispatch, confirm, audit, tiering, token trust) is done and verified. The
orchestrator already has *hands* (write tools) and *eyes* (read resources).

### 1.2 What is NOT built — the four gaps (= the user's vision)

| # | Gap | Why it matters | Evidence |
|---|---|---|---|
| **G1** | **Orchestrator skill / playbook** — no knowledge layer teaching the orchestrator *how* to orchestrate (when to spawn, how to write a worker brief, how to use the plan board). | The orchestrator has tools but no strategy. This is the user's central idea. | pkg `prompts/index.ts:4` = *"no prompts yet"*; no `.claude/skills` in repo |
| **G2** | **Plan-on-Planning-board** — no MCP tool writes notes/checklist/tasks to a Planning board. `spawn_board('planning')` makes an **empty** board; nothing populates it. | The visible shared plan is the differentiator; today it can only be hand-drawn. | no `addNote`/`addTask`/`write_plan` tool in either repo; `configure_board` is terminal-keys only |
| **G3** | **Roles** — no UI/backend/security concept. `launchCommand` is free text; token tier is only orchestrator/worker. | Role specialization + role-scoped tool allowlists is how a real swarm divides labor safely. | no `role` field on board/token; `mintBoardToken` tier ∈ {orchestrator, worker} |
| **G4** | **Agent bootstrap** — `spawn_board(prompt)` parsed but **never applied** to a `launchCommand`; no per-board `.mcp.json`+token written so a spawned CLI auto-connects to the canvas MCP server. | Without this the swarm is **not drivable end-to-end** — you cannot spawn a board that *becomes* a wired agent. | `mcpOrchestrator.ts:273` ("accepted now but applied in T3.3"); no `writeMcpJson` call in app (`config/mcpJson.ts` exists in pkg, unused by app) |

### 1.3 Primitives that already exist to close the gaps (so the build is additive)

- **G2 plan-board:** `addBoard(type,'planning',{id})` + `updateBoard(id,{elements})` (renderer); the
  Planning **checklist element** already supports `{id,label,done}` items with pure transforms
  (`makeChecklist` / `toggleItem` / `addItem` / `setItemLabel` in `planning/elements.ts`).
  `PATCHABLE_KEYS['planning']` already allows `elements`. **Missing:** an `mcp:command` variant
  (`updateBoard`/`writePlan`) so MAIN can push elements, + an MCP tool + a `canvas://board/{id}/plan`
  resource.
- **G4 bootstrap:** `pty.ts` already writes `board.launchCommand` as the first PTY line on spawn
  (`pty.ts:549-553`); `configure_board` can already set `launchCommand` behind confirm. **Missing:**
  apply `spawn_board.prompt` → an `initialPrompt`/`launchCommand`, and generate `.mcp.json`+token into
  the board cwd (the pkg's `config/mcpJson.ts` already knows the file shape).
- **G3 roles:** a `role` string folds onto board config (additive, no migration) and onto the minted
  token; the on-canvas role pill reuses the existing agent-identity-pill chrome.
- **G1 skill:** pure authoring (`.claude/skills/...`) + a project "scaffold" action that writes it.

---

## 2. Competitor landscape (research, 2026-06-05)

### 2.1 The four dominant orchestration UX patterns

| Pattern | Description | Representative tools |
|---|---|---|
| **Worktree-tabs / workspace list** | Human manually creates N isolated workspaces; each = a branch + agent session; review/merge separately. **No AI orchestrator.** | Conductor (conductor.build), Claude Squad (tmux TUI), vibe-kanban (kanban→workspace), Nimbalyst (ex-Crystal), Sculptor (containers) |
| **Canvas of terminals (spatial)** | Each agent = a draggable node on a 2-D canvas; human connects them with cables. **No AI orchestrator** (human is the orchestrator). | **Maestri** (themaestri.app) — our closest rival, Mac-only |
| **Node-graph / DAG** | Agents are graph nodes + typed edges; routing is visual + editable. LLM *pipelines*, not live terminals. | LangGraph Studio, Rivet, Flowise, Langflow, AutoGen Studio, n8n, Sim Studio |
| **Hidden orchestrator / cloud** | A lead agent or API decomposes + dispatches; user sees a task/PR list, **not** the orchestration. | Factory (droids), Warp/Oz, Devin, OpenHands, GitHub Agent HQ `/fleet`, Ruflo (ex-claude-flow), Anthropic's internal research system, **Claude Code Agent Teams** |

### 2.2 Selected profiles (the load-bearing ones)

- **Maestri** — Mac-native infinite canvas of terminal nodes connected by physics cables; agents share
  canvas **notes** as an ad-hoc scratchpad (Claude Code edits a note, another agent reads it). A
  passive on-device companion (Ombro) summarizes activity. **No AI orchestrator, no roles, no plan
  surface, no isolation model.** Closest spatial competitor; validates the canvas-of-terminals UX,
  leaves the orchestrator + plan-board + roles wide open.
  ([docs](https://www.themaestri.app/en/docs/intro))
- **Claude Code Agent Teams** (Anthropic, v2.1.32+, experimental) — **lead + shared task list +
  peer mailbox**; lead spawns N teammates (each its own Claude), teammates self-claim/assigned tasks,
  communicate peer-to-peer, and there is a **plan-approval gate** (teammate drafts a plan → lead
  approves before it writes). Display = in-process (Shift+Down to cycle) or tmux split panes —
  **orchestration is NOT visually surfaced.** Predefine roles via `.claude/agents/*.md` (system prompt
  + tool allowlist). This is the single strongest validation: the exact pattern the user wants,
  shipping from Anthropic, but **invisible** — the visibility is the gap.
  ([docs](https://code.claude.com/docs/en/agent-teams))
- **Anthropic multi-agent research system** — LeadResearcher plans → writes plan to memory → scales
  effort (1 agent simple → 10+ complex) → spawns 3–5 subagents in parallel with explicit
  objective/format/tools/boundaries → synthesizes → CitationAgent. ~15× tokens vs solo; 90.2% better
  on the research eval. Synchronous (lead waits for slowest). Source of the delegation-brief anatomy +
  effort-scaling pattern. ([blog](https://www.anthropic.com/engineering/multi-agent-research-system))
- **Ruflo** (ex-claude-flow, ruvnet, ~31k★) — Queen node routes tasks to 100+ role agents; SPARC
  phase-gated method (Spec→Pseudocode→Architecture→Refinement→Completion); a **web dashboard** shows
  every agent's role/step/budget/status. Role library + phase gates are borrowable; the UI is a
  dashboard, not live terminals. ([repo](https://github.com/ruvnet/ruflo))
- **vibe-kanban / Conductor / Claude Squad** — the worktree-isolation pattern done well: branch +
  worktree per task, inline diff review, human writes every prompt. Borrow the **workspace-receipt
  card** (branch + path + agent + status, click to open the terminal) as the plan-item↔worker link.

### 2.3 White space (what nobody does well)

1. **A *visible* AI orchestrator that writes + dispatches prompts to live worker terminals.** Everyone
   is either human-driven or hidden-orchestrator. Watching the orchestrator compose a brief and send
   it to a named terminal, with output streaming back, is unclaimed.
2. **Role-specialized worker terminals + a live planning board, co-located spatially.** Ruflo has roles
   (dashboard); Maestri has terminals (no roles, no plan). Nobody has both as first-class canvas
   elements.
3. **The planning board as the shared scratchpad the orchestrator AND workers AND human all edit.**
   Maestri's notes are ad-hoc; LangGraph's state is code-defined. A spatial, human-interruptible plan
   is open.
4. **Human-interruptible orchestrator with spatial transparency** — pause, edit the plan on the board,
   resume, all while watching the terminals.

### 2.4 Borrowable ideas (named, concrete)

| Source | Idea | Maps to |
|---|---|---|
| Claude Agent Teams | **Subagent role files** (`.claude/agents/<role>.md` = system prompt + tool allowlist) | H1 `ROLES.md` / role library (G3) |
| Claude Agent Teams | **Plan-approval gate** (worker drafts plan → approve before writing) | H3 high-tier confirm; M10 `require_plan_approval` |
| Claude Agent Teams | **`TaskCreated`/`TaskCompleted` hooks** as quality gates | H2 plan-board gates; M9 `register_gate` |
| Anthropic research | **Effort-scaling param** + **compressed-summary return** + **5-part delegation brief** | H1 skill content (delegation brief, token budget, scaling heuristics) |
| Ruflo | **SPARC phase-gated plan** + **role library** | H1 roles; H2 plan-board phases (optional) |
| vibe-kanban | **Workspace-receipt card** linking plan-item ↔ worker terminal | H2 task↔board linkage |
| Cursor `/multitask` | **Inline spawn from the orchestrator chat** (`/spawn ui-agent "..."`) | H1 skill ergonomics |
| LangGraph | **State checkpoint / time-travel** (rewind + re-dispatch) | M10 coordination (later) |

---

## 3. Orchestrator-knowledge research — where the "how" lives

### 3.1 The decision: a Skill

| Candidate home | Verdict |
|---|---|
| **Skill** (`.claude/skills/canvas-orchestrate/SKILL.md` + supporting files) | ✅ **Chosen.** Progressive disclosure (metadata ~100 tok always; body ≤5k on trigger; resources unlimited, loaded on reference) → ~free until invoked. Auto-triggers on natural language. Co-located with the project. Can `context: fork` into an isolated subagent. Supporting files (`ROLES.md`, scripts) bundle without context cost. |
| CLAUDE.md / AGENTS.md | Always-on cost; for **always-true facts only** (MCP URL, tool list, pnpm rule). Holds a one-line pointer to the skill, not the playbook. |
| MCP prompt (server-provided) | Too weak — a prompt template with no multi-step sequencing/conditionals; the model decides what to do with it. Fine as a "here's how to use `spawn_board`" reminder, not the full playbook. |
| Subagent def (`.claude/agents/*.md`) | The home for **worker roles** (G3), not for the orchestration **strategy**. Note: subagents can't spawn subagents (one level deep) → the orchestrator must be the **main session agent** (or a skill in it), never itself a subagent. |
| Hardcoded system prompt | Not versioned, not swappable, not readable on demand. |

### 3.2 Skill outline — `canvas-orchestrate/SKILL.md`

```
---
name: canvas-orchestrate
description: >
  Run a multi-board canvas orchestration session: decompose a feature into
  parallel worker boards (UI, backend, security), spawn them via MCP, maintain
  the planning board as the shared plan, coordinate handoffs, aggregate results.
  Invoke when the user says "orchestrate", "run a feature sprint", "spawn
  workers", or describes a multi-zone task.
---
1.  WHEN TO ORCHESTRATE vs SOLO   (solo if ≤1 zone / small; orchestrate if multi-zone or >2 parallel subtasks)
2.  SPAWN DECISION TREE           (1 subtask → assign_prompt; 2–4 → parallel spawn; >4 → two-phase DAG, ≤4 live)
3.  WORKER ROLES                  (reference ROLES.md: ui / backend / security / docs / test / reviewer)
4.  DELEGATION BRIEF TEMPLATE     (ROLE · CONTEXT · SCOPE+exclusions · SUCCESS=measurable · BOUNDARIES+BLOCKER tag)
5.  PLANNING BOARD AS SHARED PLAN (write tasks before spawning; one item per task; workers tick via write_result)
6.  HANDOFF vs ASSIGN vs RELAY    (handoff=blocking/dependent; assign=parallel-safe; relay=A→B along a drawn cable)
7.  AGGREGATION PROTOCOL          (wait_for_all → read summaries, not raw transcripts → synthesize → security pass last)
8.  INTERRUPT & ERROR HANDLING    (BLOCKER tag → interrupt + surface to human; timeout → mark blocked, continue others)
9.  TOKEN BUDGET                  (~15× solo; ≤4 live workers; compressed-summary returns only)
10. SCALING HEURISTICS            (re-assess after phase 1; never spawn all at once)
```
Supporting files: `ROLES.md` (per-role system-prompt templates + tool allowlists + the `write_result`
contract) · `scripts/read_plan.sh` (reads the plan resource, prints a summary — output enters context,
script does not).

### 3.3 Delegation-brief anatomy (the worker prompt the orchestrator emits)

Workers get **no parent context** — every brief must be self-contained:
`ROLE` (who you are) · `CONTEXT` (plan board id + `canvas://memory`, **by reference not copy**) ·
`SCOPE` (exact files/modules + explicit exclusions to prevent peer overlap) · `SUCCESS` (measurable:
tests green, typecheck clean, `write_result` called) · `BOUNDARIES` (hard constraints + "emit a BLOCKER
tag and stop if an out-of-scope decision is needed"). Verify on return by **measurable criteria**, not
"looks good".

### 3.4 Pitfalls + mitigations (cross-agent, not single-agent)

- **Prompt-injection cascade** (up to ~71% success in multi-agent settings; "Prompt Infection"): a
  malicious instruction in worker output flows back to the orchestrator as a trusted summary and gets
  re-delegated. **Mitigation:** treat all `write_result`/output content as **untrusted user input**;
  never let it auto-drive an action; high-tier confirm stays mandatory for anything derived from worker
  output. (This is the locked lethal-trifecta discipline — H3 must not weaken it.)
- **Context bloat / token blow-up** (~15×): workers return **compressed summaries**; large outputs go
  to `write_result` server-side; the orchestrator's context holds the *plan*, not the *work*.
- **Over-spawning** (Anthropic hit 50+ for trivial queries): encode scaling heuristics in the skill;
  hard cap live workers (≤4, reuse the landed spawn cap).
- **Error propagation / deadlock:** per-phase gates; two-phase DAG (parallel-safe first, dependents
  after aggregate); `handoff_prompt` for dependencies, `assign_prompt` for parallel; `maxTurns` +
  `interrupt` for runaways.

---

## 4. Proposed architecture — one adapter, two drivers

The landed `mcpOrchestrator.ts` adapter (MAIN-side) is the shared core. **"Both orchestrator models"
falls out of it for free** — the agent-board drives it over loopback HTTP; the desktop brain drives the
*same methods* in-process.

```
              ┌───────────────── Orchestrator adapter (MAIN, landed + extended) ─────────────────┐
              │  spawn_board · handoff/assign/relay · interrupt · write_result · write_plan ·     │
              │  confirm (tiered) · audit · roles · token-mint · .mcp.json bootstrap             │
              └───────────────▲────────────────────────────────────────────────▲────────────────┘
   Model 1 (agent-board)      │ loopback HTTP + bearer token         in-process │ Model 2 (brain)
   a Terminal running `claude`│ (existing MCP transport)             direct call│ llmService (Context
   with the orchestrator token│                                                 │ subsystem) fed the
   + the canvas-orchestrate   │                                                 │ same playbook as a
   skill                      │                                                 │ system prompt
```

- **Model 1 (primary, = landed M0–M4):** orchestrator is a visible Terminal board; you chat with it.
- **Model 2 (selectable):** a canvas "Orchestrate" button; the brain calls the adapter directly (no
  HTTP), reusing the *same* confirm + audit + tier guards. No security fork.
- Invariant: both paths funnel through one confirm + audit + tier gate. Adding Model 2 must not create
  a second, weaker path.

---

## 5. The four net-new bundles (H0–H4)

### H0 — Agent Bootstrap *(the unlock — nothing is drivable without it)*
- `spawn_board(prompt, role)` finally **applies**: persist a role `launchCommand` (e.g. `claude`) + an
  `initialPrompt`, so a spawned board auto-launches a wired agent.
- MAIN writes a per-board `.mcp.json` (+ minted token + server URL) into the board `cwd` so the CLI
  auto-discovers the canvas MCP server. **Agent-agnostic** (Claude Code first; per-CLI path matrix —
  see roadmap-mcp Open-Q #3). Reuses pkg `config/mcpJson.ts`.
- **Acceptance:** spawn an orchestrator board → it spawns UI/backend/security workers → they connect
  back + appear on the canvas with their role pill.

### H1 — Orchestrator skill + role library
- Author `.claude/skills/canvas-orchestrate/SKILL.md` + `ROLES.md` (§3.2).
- Add a `role` field to board config + minted token (orchestrator/ui/backend/security/docs/test/
  reviewer **+ custom**); role-scoped **tool allowlist** per worker. On-canvas **role pill** (reuse
  agent-identity-pill chrome).
- A **"Scaffold orchestration"** project action: writes the skill + role files + a CLAUDE.md MCP-facts
  block into the project so any opened CLI agent inherits the playbook.

### H2 — Plan-on-Planning-board *(the visible shared plan)*
- New MCP tools `write_plan(boardId, items[])` + `update_task(taskId, status)`; new resource
  `canvas://board/{id}/plan`. Built on the **existing Planning checklist element** (task = checklist
  item) via a new `mcp:command` (`updateBoard`/`writePlan`) → renderer `updateBoard(id,{elements})`.
- Task ↔ worker linkage: an `orchestration` connector (M2) **or** a `linkedBoardId` field draws a
  plan-item → the worker board executing it (the workspace-receipt idea).
- Workers tick items via `write_result` → orchestrator reflects on the board. Human edits the plan
  mid-flight.

### H3 — Tiered + session confirm + ADR
- Risk tiers per (tool × role): **high** (security/auth/git/`launchCommand`/`answer_permission` /
  anything derived from worker output) = **always** mandatory confirm; **low** (a routine worker
  prompt from a trusted orchestrator) = covered by a **session grant** ("approve orchestrator X for N
  minutes / N dispatches").
- Kills the confirm-storm while keeping human-in-loop. **New ADR** documents the relaxation inside the
  lethal-trifecta model (extends ADR `0003`). Builds on landed `mcpConfirm.ts`.

### H4 — Brain-as-orchestrator (Model 2, selectable)
- `llmService` (Context subsystem) drives the shared adapter in-process, fed the same playbook as a
  system prompt; a canvas "Orchestrate" entry point. Reuses H0–H3. Optional — ships after the
  agent-board path is proven.

---

## 6. Completing the existing roadmap (M5–M10 — already designed)

Referenced from `docs/roadmap-mcp.md`, not re-specified here. Sequenced by dependency below.

- **M5 Barriers** (🔶 in progress) — `wait_for_idle` / `wait_for_all` + SSE `canvas://attention` (no
  poll). Needed for sequenced fan-out; the H1 skill references `wait_for_all`.
- **M6 Feature Workspaces** — git-worktree-per-board-**zone**; isolates file-writing workers (UI on its
  branch, backend on its branch) → no same-file collisions. Carries the locked safety rules
  (reuse-if-exists, never nest-init, keep-on-disk+prompt on dirty delete, `git worktree remove` never
  `rm -rf`).
- **M7 Git tools** — board-scoped diff / commit / merge (confirmed, audited, conflicts flagged not
  auto-resolved). ⛓ M6.
- **M8 `answer_permission`** — approve/deny a permission prompt inside another agent's shell, **only**
  through an unconditional human-confirm. ⛓ M4, M5.
- **M9 Best-of-N** — fan N attempts across worktrees, judge (Brain or judge-board + deterministic
  `register_gate`), land exactly one winner. ⛓ M6.
- **M10 Hardening** — coordination task-graph (`canvas://tasks` + claim/dependency), worker mailbox,
  injection provenance + worker instruction-hardening, network-egress restriction, **session
  revocation** on board close, stateless-restart survival, packaging.

---

## 7. Sequence + the demo milestone

```
H0 Bootstrap ─▶ H1 Skill+Roles ─▶ H2 Plan-board ─▶ H3 Tiered-confirm ──▶ ★ DEMO MILESTONE
        └▶ M5 Barriers (∥, in progress) ───────────────┘                  (orchestrator + UI +
                                                                            backend + security,
H4 Brain-orchestrator (Model 2) ◀── reuses H0–H3                           plan on board, all
        ▼                                                                   visible, tiered-confirm)
M6 Workspaces ─▶ M7 Git ─▶ M8 answer_permission ─▶ M9 Best-of-N ─▶ M10 Hardening
```

**★ Demo milestone (H0–H3 + M5)** = the exact user scenario: an orchestrator board reads the skill,
writes a plan to a Planning board, spawns role-tagged UI/backend/security workers, dispatches briefs,
waits on `wait_for_all`, aggregates results onto the board — **all visible on the canvas**, with
tiered + session-scoped confirmation. This is the shippable, demo-able MVP and the marketing money
shot (the "visible agent teams" hero).

---

## 8. Decisions, risks, open questions

### 8.1 Decisions (2026-06-05 brainstorm)
- **Both orchestrator models, selectable** — one shared adapter; agent-board primary, brain (Model 2)
  via H4.
- **Full phased plan** — 4 bundles (H0–H4) + complete M5–M10.
- **Tiered + session-scoped confirmation** — needs a new ADR (touches the locked safety contract).
- **Roles** = built-in library + custom (not fixed-only, not freeform-only).
- **Plan surface** = the existing Planning checklist element (not a new board type).
- **Knowledge home** = a Skill (+ROLES.md); CLAUDE.md only for always-on MCP facts.
- **Agent-agnostic preserved** — Claude Code first bootstrap target; others via a per-CLI matrix.
- **Extends** `roadmap-mcp.md` (adds H0–H4); does not replace it.

### 8.2 Risks
- **Confirm-relaxation vs lethal trifecta** — H3 must keep worker-derived content at high-tier always;
  session grants apply only to a *trusted orchestrator's own* low-risk prompts. ADR-gated.
- **Token blow-up** (~15×) — skill caps live workers + effort scaling + compressed-summary returns.
- **Per-CLI bootstrap differences** — `.mcp.json` path/format varies; matrix it, Claude Code first.
- **Injection from `write_result`** — never auto-act on worker output.
- **Process/coordination** — feature work on worktree(s), not `main`; full gate + e2e after each merge.

### 8.3 Open questions (resolve at the relevant phase)
1. **Plan↔worker link representation:** an `orchestration` connector (visual cable, reuses M2) vs a
   `linkedBoardId` field on the plan item vs both? (Lean: connector for the visual, field for the data.)
2. **Brain-orchestrator UX (H4):** a dedicated "Orchestrator" panel vs an invisible background driver
   surfacing only on the canvas + plan board?
3. **Session-grant scope (H3):** time-boxed, count-boxed, or both; per-orchestrator or per-project;
   revoked on what events (board close, project switch, idle)?
4. **Role tool-allowlists:** enforced server-side by token tier (preferred, like the current
   orchestrator/worker split) vs advisory in the role prompt?
5. **Per-CLI bootstrap matrix (G4):** confirm the exact `.mcp.json` path + token env each target CLI
   reads (Claude Code / Codex / Cursor / Gemini) — see `mcp-spec-state-2026-06` (memory).

---

## 9. Sources

**Internal:** `docs/roadmap-mcp.md` · `docs/reviews/2026-06-05-mcp-indepth-review.md` ·
`docs/decisions/0003-llm-egress.md` · `Z:\canvas-ade-mcp\src\*` · `Z:\Canvas ADE\src\main\mcp*.ts` ·
memory `mcp-spec-state-2026-06`, `canvas-ade-mcp`, `maestri-competitor`, `feature-workspaces-vision`.

**Competitors:** [Maestri](https://www.themaestri.app/en/docs/intro) ·
[Conductor](https://docs.conductor.build/) · [Claude Squad](https://github.com/smtg-ai/claude-squad) ·
[vibe-kanban](https://github.com/BloopAI/vibe-kanban) · [Nimbalyst/Crystal](https://nimbalyst.com/crystal/) ·
[Sculptor](https://imbue.com/blog/sculptor-announce) · [Cursor](https://cursor.com/blog/agent-best-practices) ·
[Warp/Oz](https://www.warp.dev/oz) · [Factory.ai](https://www.digitalapplied.com/blog/factory-ai-multi-agent-coding-platform-review) ·
[OpenHands](https://www.openhands.dev/blog/openhands-product-update---may-2026) ·
[Ruflo](https://github.com/ruvnet/ruflo) · [GitHub /fleet](https://github.blog/ai-and-ml/github-copilot/run-multiple-agents-at-once-with-fleet-in-copilot-cli/) ·
[LangGraph](https://www.langchain.com/langgraph) · [CrewAI](https://docs.crewai.com/) ·
[AutoGen](https://www.microsoft.com/en-us/research/project/autogen/) ·
[OpenAI Agents SDK](https://openai.github.io/openai-agents-python/).

**Orchestrator knowledge / patterns:**
[Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams) ·
[Claude Code Skills](https://code.claude.com/docs/en/skills) ·
[Claude Code Subagents](https://code.claude.com/docs/en/sub-agents) ·
[Agent Skills (Anthropic)](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) ·
[Anthropic multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) ·
[Arize orchestrator-worker comparison](https://arize.com/blog/orchestrator-worker-agents-a-practical-comparison-of-common-agent-frameworks/) ·
[Prompt Infection (arXiv 2410.07283)](https://arxiv.org/pdf/2410.07283) ·
[Wiz — agent orchestration security](https://www.wiz.io/academy/ai-security/ai-agent-orchestration).
