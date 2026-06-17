# Command Board — orchestrator follow-ups (post A–E)

**Status:** Proposal / not scheduled. Captures three user-requested capabilities (2026-06-18) for **after**
the A–E umbrella ships. The umbrella scope stays **frozen** at A–E + the three live-fix follow-ups
(viewport spawn placement, prompt-submit two-write, multi-line submit well).
**Parent design:** `README.md` (this folder) — the grand plan, prerequisites PR-0…PR-7, phases A–F.
**Author:** working session (feasibility grounded against the shipped tree).

> The headline finding: two of the three asks are **mostly already built** — they need *connector-aware
> routing*, not new write paths. The third (orchestrator-as-chat-agent) is **architecturally pre-wired**
> but is a phase of its own, not a slice.

---

## The three asks (verbatim intent)

1. **Terminal → Planning board.** A terminal agent should write a plan **with diagrams** onto a
   connected Planning board.
2. **Terminal → Browser board.** When a terminal brings up a dev server, a connected Browser board
   should **auto-load** that dev-server URL.
3. **Orchestrator-as-agent.** The orchestrator becomes "an agentic CLI itself" — it **reads the reports
   from every terminal** (e.g. one audit worker + one task worker), **knows the whole picture**, and
   **becomes the user's chat agent**.

---

## Feasibility — what's shipped vs. the gap

| Ask | Already shipped | Gap to your vision | Size |
|---|---|---|---|
| **1 — plan + diagrams** | The gated MCP content-write (`addPlanningElements` / `patchPlanning`) **already accepts `diagram` ops** — `planningMcpApply.ts` materializes `{kind:'note'|'checklist'|'text'|'arrow'|'diagram'}`; `diagram` renders the S4 Mermaid element. A worker can write a plan *with diagrams* **today**. | (a) **Connector-aware targeting** — today the agent names a planning board by id; you want it to auto-target the planning board *cabled to the terminal*. (b) The worker must be *told* to emit planning/diagram ops (a launch-prompt instruction / skill). | S–M |
| **2 — dev-server auto-load** | Runtime **port-detect → push-to-preview** (Slice C′) parses the server-printed URL and pushes it to a preview. | **Scope the push to the *connected* Browser board** via the connector graph (not the current behavior), automatically. | S–M |
| **3 — chat orchestrator** | Per-terminal `BoardResult` collection (`write_result` + Phase D `gitDiff`), cross-zone roll-up (Phase E), the read-only **app self-model** (`appModel.ts` / `describeApp()` — board types, tool catalog, live canvas, rules), the MCP tool surface (spawn/dispatch/relay/patchPlanning/gitDiff), the human gate, `llm.summarize`, and the Context subsystem (`canvas://memory`). | (1) Expose **`canvas://app-model` as an MCP resource** (the deferred PR-3b — `appModel.ts:15`). (2) A real **agentic loop** (reason→act→observe, multi-turn) replacing today's one-shot "summarize→dispatch" scripted machine. (3) A **chat surface** on the Command board. (4) The orchestrator **reasoning over** the collected audit/task reports to answer + decide. | L (a phase) |

**Shared primitive for Asks 1 & 2:** *connector-aware routing* — "deliver a terminal's output to the
board it is spatially cabled to." Asks 1 and 2 are the planning-edge and browser-edge of the same idea,
and it reuses the existing connector model (the orchestration cable already **is** the authorization for
`relay_prompt` — `mcpOrchestrator.ts`).

---

## Proposed phasing (after A–E)

### Phase G — Connector-aware routing (Asks 1 & 2)
The orchestrator routes a worker's outputs to the boards it is connected to, automatically, all through
the existing gate.

- **G0 — connector model for worker edges.** A typed connector terminal→planning ("seed plan here") and
  terminal→browser ("preview here"), drawn on the canvas or auto-created by `spawnGroup`. The cable is
  the route + the authorization (mirrors `relay_prompt`).
- **G1 — terminal → connected planning (plans + diagrams).** On a worker producing a plan, route
  `addPlanningElements` (incl. `diagram` ops) to the *connected* planning board. Diagram support exists;
  this adds connector targeting + the worker instruction. Depends on **PR-5c** (`spawn_group` MCP tool,
  already a TODO in `README.md`) so the wiring is agent-callable.
- **G2 — terminal → connected browser (dev-server auto-load).** Scope Slice C′'s detected URL push to
  the *connected* browser board.

Security: no new write path — `addPlanningElements` stays gated; the browser push is a renderer
navigation (no PTY); browser content still never reaches the PTY channel.

### Phase H — Conversational orchestrator (Ask 3) — *the headline, a phase not a slice*
Turn the scripted dispatcher into a genuine agent the user **chats with**, while the scripted state
machine stays the safety envelope and **every write still pays `runGatedWrite`**.

- **H1 — `canvas://app-model` MCP resource (PR-3b).** Expose the already-built `describeApp()` model as a
  read-only resource so an agent can *read* the whole board (types, tools, live canvas, rules). The one
  net-new bridge; security-neutral (read-only, no token).
- **H2 — agentic loop.** A reason→act→observe loop over the app-model + collected `BoardResult`s + the
  Context `canvas://memory`, replacing the one-shot "summarize→dispatch". Plans freely; acts only through
  the gated MCP tools. (This is the "orchestrator harness / visible agent teams" vision.)
- **H3 — chat surface.** A conversational thread face on the Command board (a 5th view beside kanban ①,
  recap ②, groups ③, rail ④) — the user talks to the orchestrator; it answers grounded in board state.
- **H4 — multi-report synthesis.** The orchestrator reads N workers' reports (audit worker + task worker)
  and synthesizes/answers — the data is already collected (Phase D/E); this is the reasoning over it.

```text
Command board — chat face (H3), sketch (full token mock at impl time)
┌──────────────────────────────────────────────┐
│ Orchestrator  · 2 zones · 1 done · 1 running   │  ← reads app-model + reports
├──────────────────────────────────────────────┤
│ you  ▸ audit the auth flow and fix what's broken│
│ orch ▸ spawning Audit + Fix zones…   [view]    │
│ orch ▸ Audit found 3 issues (auth.ts:40,…).     │
│      ▸ Fix zone done · +218 −37 · [view diff]   │
│ you  ▸ open the dev server in a browser board   │
├──────────────────────────────────────────────┤
│ › talk to the orchestrator…        [ Send ⏎ ]  │
└──────────────────────────────────────────────┘
```

---

## Open design decisions (for Ask 3)

1. **Where the agent *runs*.** Is the orchestrator an **in-app agent loop** (LLM in MAIN driving the MCP
   tools) or **itself an agentic CLI in a terminal** that happens to hold the orchestrator token? The
   in-app loop keeps the renderer token-free and the gate central; the CLI form reuses real agent tooling
   but needs careful token containment. *(Recommendation: in-app loop; the CLI is a worker, not the host.)*
2. **Autonomy bound.** How many act-steps may the loop take per user turn before it must report back?
   (A turn budget + the spawn cap as the runaway guard.)
3. **Gate UX at agent scale.** A chatty agent multiplies `runGatedWrite` confirms → ties into PR-7
   (batch-auth / plan-approval).
4. **Memory scope.** How much of `canvas://memory` + transcripts the chat agent may read (consent-gated,
   as the recap egress already is).

---

## Constraints honored (unchanged)
- Security never weakened — `node-pty` + `simple-git` MAIN-only; renderer holds **no token**; all MCP IPC
  frame-guarded; **every cross-board write pays `runGatedWrite`**; browser content never reaches the PTY.
- Connector = authorization (the `relay_prompt` discipline) for the new worker edges.
- Design-artifact-before-code: the chat face ships a token-built mock for sign-off before implementation.
- Doc lifecycle: durable proposal (not a slice spec); per-phase specs are created/deleted on their own
  `feat/*` branches when these are scheduled.

## Pointers
- Parent: `README.md` (this folder) — prerequisites PR-5c (spawn_group tool), PR-6 (planning seed +
  Mermaid plan diagram), PR-7 (batch-auth) are the nearest existing hooks for G1/H.
- Diagram ops: `src/renderer/src/store/planningMcpApply.ts` (`diagram` kind).
- App-model: `src/main/appModel.ts` (`describeApp()`; `canvas://app-model` resource deferred → PR-3b).
- Browser auto-wire: Slice C′ port-detect → push-to-preview (`docs/archive/build-history.md` › Phase 3-C′).
