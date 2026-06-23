# Canvas ADE — MCP Feature Audit & Recommendations

**Date:** 2026-06-23  ·  **Scope:** the MCP (agent-orchestration) layer — the sibling package `@expanse-ade/mcp` v0.13.0, the MAIN host adapters, the renderer Command board, the per-CLI provisioning/onboarding flow, and the roadmap (M0–M10).  ·  **Centrepiece ask:** what reusable "skills" / "commands" would most help users, and how do they fit the locked architecture.

---

## 1. Executive summary

**What it is today.** Canvas ADE runs a loopback streamable-HTTP MCP server *inside* Electron MAIN (mounted from the published `@expanse-ade/mcp` package via `createMcpHttpServer`). Connected CLI agents (Claude/Codex/Gemini/OpenCode) in Terminal boards, plus a singleton human-facing **Command board**, drive the canvas through a tier-gated tool/resource surface. Every cross-board PTY write passes a single unskippable pipeline — `runGatedWrite` (sanitize → CSPRNG nonce → human-confirm → TOCTOU re-check → consume → two-phase PTY write → audit) — and the whole thing is built on the "lethal-trifecta" discipline: never auto-act on tainted worker output.

**Maturity.** Mature and well-hardened through **M0–M5** plus the post-M5 Agent-Orchestration Onboarding (P0–P5, package 0.13.0) and the Command board UI (Phases A–E). 14 tools and 8 resources are wire-registered and e2e-covered. The security model is deep and correctly applied — the audit found **zero** invariant violations and a strong set of strengths (centralized gate, fail-closed confirm, unified frame guard, CSPRNG reply channels, path-traversal single-source `safeId`, serialized audit log). **M6–M10 are entirely spec-only** (worktrees, git commit/merge, answer_permission, best-of-N, task graph). The MCP **prompts** primitive — the natural home for "skills" — is a confirmed empty stub (`registerPrompts(_server){}`), and there are **no** human-facing "skill/recipe" templates anywhere (`grep skill src/` → nothing).

**The 3–5 highest-leverage moves:**

1. **Ship two pure-renderer discoverability fixes immediately** (P0, no deps): add an **Orchestration section to the Ctrl+K palette** and **canonicalize the Ctrl+Shift+A audit shortcut**. Today there is *no keyboard path* to enable orchestration, open the Command board, or view the trust-critical audit log — a hard lost-user scenario.
2. **Land the `spawnGroup` sanitizer fix now, independent of wiring** (P0 security): `mcpLifecycle.ts:155`'s `c >= ' '` filter passes DEL (0x7F) and C1 controls (0x80–0x9F) — a live terminal-escape-injection hole the Command board *already* drives over IPC today.
3. **Build the "skills" substrate, then ship skills as files first.** Fill `registerPrompts` (the hook exists, only the body is empty) and ship a **CLI-agnostic "canvas-ade" primer** generated from `appModel.ts` (which also closes the APP_TOOLS drift-guard finding). Lead each agent-facing recipe with **one** delivery layer — prefer the MCP-prompt playbook (reaches all four CLIs) over Claude-only `.md` files.
4. **Coordinated package bump:** wire-register the three MAIN-complete-but-unwired primitives (`canvas://app-model`, `spawn_group`, `await_settled`), add `write_result` `.max()` Zod caps, and the first prompt playbooks + their e2e probe — as one sibling-package + app release.
5. **Fix two standalone security gaps in MAIN:** persist `provisionedDirs` (stale bearer tokens survive a consent-revoke across restart) and extract the hand-maintained cross-bundle type mirrors (`McpCommandIn`/`PlanningOp`/`AuditEntry`) to `src/shared/` *before* adding any new command variants for skill/recipe dispatch.

A **"skill" in this product** is best defined as a **named, parameterized orchestration playbook exposed via the MCP prompts primitive** (agent-agnostic, in-package, tier-gated), complemented by **(a)** a CLI-agnostic operating-manual primer for the agents and **(b)** human-facing **recipe templates** in the Command board SubmitWell. We justify this choice in §5.

---

## 2. Current MCP surface inventory

### 2a. Agent-facing FUNCTIONS (tools + resources)

| Function | Kind | Tier | Status | Notes |
|---|---|---|---|---|
| `ping` | tool | all | shipped | health check |
| `orchestrator_ping` | tool | orchestrator | shipped | |
| `spawn_board` | tool | orchestrator + connected | shipped | cap=4 (`MCP_SPAWN_CAP`) |
| `close_board` | tool | orchestrator | shipped | graceful drain; dirty-worktree prompt deferred to M6 |
| `configure_board` | tool | orchestrator + connected | shipped | launchCommand path gated; shell/cwd path **un-audited** (see §3) |
| `handoff_prompt` | tool | orchestrator | shipped | blocking, event-driven settle |
| `assign_prompt` | tool | orchestrator | shipped | fire-and-forget |
| `relay_prompt` | tool | orchestrator + connected | shipped | cable = authorization; TOCTOU re-check (BUG-021) |
| `interrupt` | tool | orchestrator | shipped | Ctrl-C |
| `add_planning_elements` | tool | orchestrator + connected | shipped | flag-gated (consent); full-content confirm |
| `git_diff` | tool | **orchestrator only** | shipped | read-only; 1MB src cap, 100KB payload clamp |
| `wait_for_idle` / `wait_for_all` | tool | orchestrator | shipped | event-driven barriers |
| `write_result` | tool | all (worker self-report) | shipped | **no Zod `.max()` caps** (BUG-009; MAIN compensates) |
| `canvas://boards` | resource | n/a | shipped | + file-tree `path`/`fileRefs` |
| `canvas://board/{id}/status` | resource | n/a | shipped | |
| `canvas://board-states` | resource | n/a | shipped | bucket roll-up |
| `canvas://attention` | resource | n/a | shipped | **only subscribable** (SSE) |
| `canvas://board/{id}/output` | resource | n/a | shipped | 25k cap, paginated |
| `canvas://board/{id}/result` | resource | n/a | shipped | `{present:false}` until set |
| `canvas://memory` | resource | n/a | shipped | 100k cap; LLM-gen → untrusted |
| `canvas://board/{id}/summary` | resource | n/a | shipped | path-guarded id |
| `registerPrompts` (prompts primitive) | prompt | n/a | **stub** | `function registerPrompts(_server){}` — empty |
| `SCOPE_ANSWER_PERMISSION` | scope | orchestrator | **stub** | granted to every orchestrator token; **no tool exists** |
| `canvas://app-model` | resource | orchestrator | **partial** | MAIN-complete (`describeApp()`), **not wire-registered** (PR-3b) |
| `spawn_group` | tool | orchestrator | **partial** | MAIN-complete (`spawnGroup()`), **not wire-registered** (PR-5c) |
| `await_settled` | tool | n/a | **partial** | MAIN-only (IPC); **not wire-registered**; busy-polls |
| `answer_permission` (M8) | tool | orchestrator | **spec-only** | scope reserved, tool absent |
| M7 `commit` / `merge` / `get_changed_files` / `canvas://board/{id}/diff` | tool/resource | orchestrator | **spec-only** | depends on M6 |
| M9 `spawn_fanout` / `broadcast_prompt` / `judge_outputs` / … | tool | orchestrator | **spec-only** | depends on M6 (merge half) |
| M10 `canvas://tasks` / `create_task` / `claim_task` / … | tool/resource | orchestrator | **spec-only** | |

### 2b. Human-facing COMMANDS (Command board + palette)

| Surface | Status | Notes |
|---|---|---|
| Command board (Phases A–E): kanban, SubmitWell, TaskCard, WorkerConfigDialog, GroupsView, CommandRecapView | shipped | the human's orchestrator UI |
| `useCommandDispatch` choreography (engineer → spawn → gated dispatch → awaitSettled → gitDiff) | shipped | run-generation guard (FIND-005) |
| OrchestrationConsentModal / OrchestrationSyncModal | shipped | persist-then-act; **still say "Canvas ADE"** |
| AuditLogViewer | shipped | Ctrl+Shift+A **self-registered**, palette/`?`-sheet invisible |
| OrchestrationEdge | shipped | neutral stroke; no live relay animation |
| Ctrl+K palette `connect`/`disconnect` 2 boards | shipped | the **only** MCP-adjacent palette verbs (in "Groups") |
| **Orchestration palette section** | **stub** | placeholder comment only (`commandRegistry.ts:11`) |
| Command-board palette verbs (dispatch/retry/recap/cancel) | **absent** | direct-pointer only |
| On-canvas attention queue (M5-T5.4) | **absent** | data feed shipped, UI never built |
| `blocked` / `awaiting-review` status emission | **dead code** | defined in `boardStatus.ts`, never returned (needs M8) |
| Recipe/skill templates | **absent** | no canned dispatch templates |

---

## 3. Audit findings

### Severity-sorted summary

| # | Sev | Dimension | Finding | File |
|---|---|---|---|---|
| F1 | **HIGH** | Completeness | M6–M10 entirely spec-only; M6 blocks M7/M9/M10; `close_board` does **not** fulfill the dirty-worktree keep+prompt contract today | `docs/roadmap-mcp.md` |
| F2 | **HIGH** | Skills-gap | MCP prompts primitive is an empty stub — no "skills" surface exists | `dist/index.js:345` |
| F3 | **HIGH** | UX | Ctrl+Shift+A audit shortcut invisible to `?` sheet + Ctrl+K (trust-critical surface hidden) | `AuditLogViewer.tsx:70` |
| F4 | **HIGH** | UX | No Orchestration palette section — zero keyboard path to set up / drive MCP | `commandRegistry.ts:11` |
| F5 | **MED** | Security/Correctness | `spawnGroup` sanitizer (`c >= ' '`) passes DEL + C1 (8-bit CSI/OSC) → escape injection | `mcpLifecycle.ts:155` |
| F6 | **MED** | Correctness | `configureBoard` human-deny audits `'rejected'` not `'denied'` — corrupts forensic distinction on the riskiest path | `mcpOrchestrator.ts:503` |
| F7 | **MED** | Correctness | `configureBoard` shell/cwd-only path writes **no audit** (success or failure) | `mcpOrchestrator.ts:543` |
| F8 | **MED** | Security | `provisionedDirs` in-memory only → bearer token in non-root cwd survives restart + consent-revoke | `cliProvisioners/index.ts:168` |
| F9 | **MED** | Security/Correctness | `McpCommandIn`/`PlanningOp`/`AuditEntry` hand-mirrored across bundle split, no compile-time safety | `useMcpCommands.ts:15`, `AuditLogViewer.tsx:15` |
| F10 | **MED** | Security/Completeness | `write_result` Zod schema has no `.max()` caps; only MAIN belt-and-suspenders | `dist/index.js:571`, `mcpOrchestrator.ts:62` |
| F11 | **MED** | Security | `SCOPE_ANSWER_PERMISSION` granted to every orchestrator token w/ no tool → implicit pre-authorization of any future same-named tool | `dist/index.js:1084` |
| F12 | **MED** | Completeness | `canvas://app-model` + `spawn_group` MAIN-complete but not wire-registered (agents blind to self-model + zone spawn) | `mcp.ts:114` |
| F13 | **MED** | Completeness | No MCP transport-security ADR (T0.2 deliverable; ADR 0003 explicitly defers it) | `docs/decisions/` |
| F14 | **MED** | UX | Sync modal "This project / .mcp.json / always" row is false for non-Claude users (nothing written) | `OrchestrationSyncModal.tsx:175` |
| F15 | **MED** | UX | No post-Sync "verify it works" — silent misconfiguration; port rotates on restart | `OrchestrationSyncModal.tsx` |
| F16 | **MED** | UX | Diff panel renders raw monochrome unified-diff (unreadable at scale) — the primary result artifact | `TaskCard.tsx:243`, `CommandRecapView.tsx:189` |
| F17 | **MED** | UX | No "cancel queued task" affordance; only board-delete removes a waiting task | `TaskCard.tsx` |
| F18 | **LOW** | Security | `hostGuard` passes when Host header absent (HTTP/1.0 clients bypass) | `dist/index.js:87` |
| F19 | **LOW** | Correctness | `awaitSettled` busy-polls 1s (only remaining poll loop) vs event-driven `handoffPrompt` | `mcpOrchestrator.ts:748` |
| F20 | **LOW** | Security | `SYNC_PSEUDO_BOARD` mint comment claims "discarded" but token is tracked+rotated — misleading (no leak, but invites a future regression) | `orchestrationProvision.ts:58` |
| F21 | **LOW** | Security | `CANVAS_MCP_PLANNING_WRITE` env bypasses consent with no `NODE_ENV` guard | `mcp.ts:48` |
| F22 | **LOW** | Security | Consent-revoke fires `revokeAllConnected` before `unsyncProvisioners` completes — narrow window where on-disk token is re-readable after in-memory invalidation | `orchestrationConsent.ts:141` |
| F23 | **LOW** | Security | Memory resources are LLM-generated/untrusted but served with no injection-provenance framing | `boardMemory.ts:18` |
| F24 | **LOW** | UX/Completeness | M5-T5.4 on-canvas attention queue unbuilt (data feed live, UI absent) | `docs/roadmap-mcp.md` |
| F25 | **LOW** | Completeness | `APP_TOOLS` static catalog has no compile-time sync guard with the live package | `appModel.ts:99` |
| F26 | **LOW** | UX | Consent/Sync modals copy still "Canvas ADE" not "Expanse" | `OrchestrationConsentModal.tsx:99` |

### By dimension

**Security & Safety.** The model is strong (see strengths below). The actionable, *non-optional* fixes are **F5** (sanitizer hole — must ship regardless of wiring), **F8** (stale-token persistence — the real fix, not a skill), **F10** (protocol-layer `.max()` caps), and **F11** (drop the dead scope until M8 ships, to avoid implicit pre-authorization). **F18/F21/F22/F23** are defense-in-depth hardening (require-Host, `NODE_ENV` gate on the planning env flag, reverse the revoke order so disk tokens die first, prefix memory resources with an untrusted-provenance marker). *Strengths worth preserving:* `runGatedWrite` centralization, fail-closed `mcpConfirm`, unified `isForeignSender`, CSPRNG reply channels (BUG-022/031), single-source `safeId`, serialized audit chain (BUG-024), `relay_prompt` TOCTOU re-check, `makeConnectedTokenTracker` rotate-on-respawn + mass-revoke, host+origin+bearer triple, full-content planning confirm body, 0o600 merge-not-clobber provisioner writes.

**Correctness & robustness.** **F6** (one-word fix: `'rejected'`→`'denied'` at `mcpOrchestrator.ts:503` + a unit test) and **F7** (add `configured`/`failed` audit to the shell/cwd path) restore the "every write leaves a trace" invariant on the exec-vector-adjacent config path. **F19** is the only remaining busy-poll. We **corrected** the zone-map's claim that `SYNC_PSEUDO_BOARD` tokens leak — they are tracked and rotated via `connected.track()`; the bug is the **misleading comment** (**F20**), which should be fixed to prevent a future maintainer from removing the tracking.

**Completeness.** M0–M5 fully shipped; M6–M10 zero implementation (**F1**). Three primitives are MAIN-complete but unwired (**F12**); these are *pre-M6 with no blocker* — unbundle PR-3b/PR-5c from the worktree milestone. The transport-security ADR (**F13**) is owed.

**UX & discoverability.** The top risks are discoverability (**F3**, **F4**) and trust-signal gaps (**F14**, **F15**). The result artifact is unreadable (**F16**). Smaller: cancel-queued (**F17**), routing-phase feedback, the `--dangerously-skip-permissions` default needs an inline explanation, the empty-board state should name the orchestration prerequisite.

**Skills-gap.** **F2** is the whole story: the MCP prompts hook is in place but empty, and no human-facing recipe concept exists. This is the centrepiece of §5.

---

## 4. Roadmap reality check (M0–M10)

| Milestone | Status | Concrete missing pieces |
|---|---|---|
| **M0** transport + command channel | **shipped** | host+origin+bearer triple live; **ADR never written** (F13) |
| **M1** status buckets + output/result/memory resources | **shipped** | — |
| **M2** orchestration connectors | **shipped** | no `canvas://connectors` *read* resource (see §8 — high-value miss) |
| **M3** spawn/close/configure + cap/idle-reap | **shipped** | dirty-worktree prompt on close deferred to M6 (live gap) |
| **M4** audit + confirm + handoff/assign/relay/interrupt | **shipped** | — |
| **M5** attention SSE + wait_for_idle/all + state distinction | **shipped except T5.4** | on-canvas attention **UI** unbuilt (F24); `blocked`/`awaiting-review` never emitted (needs M8) |
| **M6** Feature Workspaces (worktrees) | **spec-only** | worktree manager, zone model, dirty-on-delete prompt, `spawn_board(cwd)`→zone. **Blocks M7/M9/M10.** |
| **M7** git commit/merge | **spec-only** | `commit`/`merge`/`get_changed_files`/`canvas://board/{id}/diff` (read-side needs no M6) |
| **M8** answer_permission | **spec-only** (scope reserved) | T8.1 PTY permission-prompt heuristic + T8.2 tool. **Depends only on M4+M5 — both shipped.** |
| **M9** best-of-N | **spec-only** | `spawn_fanout`/`broadcast_prompt`/`compare_diffs`/`judge_outputs`/`promote_winner`/`merge_queue` (read-side needs no M6) |
| **M10** task graph + hardening + stateless | **spec-only** | `canvas://tasks`/claim/mailbox/guards; session-revoke on close_board; 2026-07-28 stateless-RC migration |

**Net:** the next *unblocked* milestone is **M8** (needs nothing new). The next *highest-value-per-effort* shipping is the three unwired primitives (F12) + the read-side of M7/M9 (no worktrees). M6 is the true gate for the back half and needs a concrete start date to end the "deferred post-MCP / *is* in the MCP roadmap" circular ambiguity in CLAUDE.md vs `roadmap-mcp.md`.

---

## 5. RECOMMENDED NEW SKILLS (centrepiece)

### What a "skill" IS in this product — the decision

We adjudicate the three candidate interpretations and **pick a layered answer**:

1. **MCP prompts (the 3rd primitive)** — *the primary "skill" surface.* A named, parameterized orchestration playbook (`prompts/list` + `prompts/get`) that any connected agent discovers and invokes. **Why this wins:** it is agent-**agnostic** (reaches all four CLIs — Claude/Codex/Gemini/OpenCode), lives **in the package** (one source of truth, versioned), and is **tier-gated server-side**. The hook already exists (`registerPrompts` is called in `ServerFactory.getServer()`); only the body is empty. Every risky write a playbook triggers still pays `runGatedWrite` — so a skill can *never* weaken the model.
2. **A CLI-agnostic operating-manual primer** — *the substrate that makes skills reliable.* The connected agent has the tool surface but **no manual**; it must rediscover the canvas grammar every session, and three of four CLIs don't read Claude's `SKILL.md`. A single primer (generated from `appModel.ts`) gives all CLIs the board types, tool catalog, tier model, and the **three safety rules** plainly stated.
3. **Human-facing recipe templates** — *the "skill for humans."* Canned dispatch templates in the Command-board SubmitWell that pre-fill the task text + composition + WorkerConfigDialog and **persist** across restarts.

**Why NOT lead with Claude-Code `.md` skill files:** they are Claude-only, duplicate the prompt-layer, and were the weakest delivery vehicle in critic review. The *one* survivor of that lens is the primer (which explicitly handles non-Claude CLIs via `AGENTS.md`).

### Curated, deduped, prioritized skill set

The raw proposals contained massive triple-duplication (the same ~4 workflows as a tool, a prompt, *and* a `.md` skill). The set below is the collapsed result.

| # | Skill | What it does | Composes | Placement | Effort | Risk | Priority |
|---|---|---|---|---|---|---|---|
| S1 | **`registerPrompts` scaffold** | Fill the empty hook: pass orchestrator+ctx, gate by tier server-side, pure render, never writes | — (enables all below) | `@expanse-ade/mcp` `src/prompts/` | M | low | **P0** |
| S2 | **canvas-ade primer** (operating manual) | Generated-from-`appModel.ts` primer: board types, tool catalog, tier model, 3 safety rules, lists available playbooks. Written by the provisioner as `.claude/skills/canvas-ade/SKILL.md` (claude) + `AGENTS.md` section (codex/gemini/opencode). Unit test asserts primer tools == `APP_TOOLS` → **closes F25** | reads `appModel.ts`; provisioner write path | `resources/agent-skills/` (generated) + `cliProvisioners/` | M | med | **P0** |
| S3 | **`fan-out-and-compare`** playbook | Spawn N workers within cap, broadcast the same task (one confirm lists all N targets), `wait_for_all`, read each `canvas://board/{id}/result`, present a comparison table **for the human to pick**. Never merges, never auto-acts | `spawn_board`, `handoff_prompt`/`assign_prompt`, `wait_for_all`, result resources | playbooks `fanOutAndCompare.ts` | M | med | **P1** |
| S4 | **`review-pr`** playbook | Read diff, spawn reviewer + tester workers, hand each a scoped prompt, collect both verdicts, present a consolidated review. Documents the `git_diff` orchestrator-tier asymmetry (connected callers fall back to shell `git diff`) | `git_diff`, `spawn_board`, `handoff_prompt`, `wait_for_all`, result resources | playbooks `reviewPr.ts` | S | low | **P1** |
| S5 | **`triage-attention`** playbook | Read `canvas://attention` + `board-states`, classify, propose `interrupt` for runaways — **never auto-fires** on tainted output. Honest that `blocked`/`awaiting-review` only populate post-M8 | attention/board-states resources, `interrupt` (gated) | playbooks `triageAttention.ts` | S | low | **P1** |
| S6 | **Recipe launcher** (human templates) | Built-in chips above the SubmitWell (Review PR / Implement / Test / Debug / Triage) pre-fill task + composition + WorkerConfigDialog; user-saveable; **persisted to `canvas.json`** (additive field, ADR 0007 → no floor move). Fixes "every dispatch starts blank / `lastWorkerConfig` ephemeral" | renderer only; gated dispatch unchanged | `commandDispatch.ts`, `SubmitWell.tsx`, `WorkerConfigDialog.tsx`, `boardSchema` | M | low | **P1** |
| S7 | **prompts e2e probe** | Assert `prompts/list` tier-correctness (orch sees all, connected a subset, worker none); ship with S1 | `e2e/mcp.e2e.ts` | `e2e/` | S | low | **P1** |

The cable-authorization teaching (relay/handoff) and the planning-write usage are **folded into the S2 primer**, not shipped as standalone skills (see §8 — killed).

---

## 6. RECOMMENDED NEW COMMANDS

### 6a. Agent-facing MCP tools/resources

| # | Command | Rationale | Effort | Risk | Priority |
|---|---|---|---|---|---|
| C1 | **`canvas://app-model`** (wire-register) | MAIN-complete + e2e-proven; only package registration missing. Unblocks agent self-orientation that S2–S5 lean on. Bundle the `APP_TOOLS` drift-guard test | S | low | **P0** |
| C2 | **`spawn_group`** (wire-register **+ sanitizer fix F5**) | MAIN-complete; one-call zone spawn. **The sanitizer fix is load-bearing and must ship regardless of wiring** (Command board drives spawnGroup over IPC today with the weak filter). Keep orchestrator-only to bound swarm growth | S | med | **P0** |
| C3 | **`write_result` `.max()` caps** | Close BUG-009 at the protocol layer (`summary` ≤100k, `refs` ≤256×≤256) so defense-in-depth doesn't depend on MAIN's compensating clamp surviving a refactor | S | low | **P0** |
| C4 | **`canvas://connectors`** (read-only) | *Net-new, high-leverage:* an agent currently **cannot enumerate the cables it may relay along** — it must ask the user. This resource makes relay/handoff self-verifiable; strictly read-only/loopback, zero invariant risk. Outranks the task-graph | S | low | **P1** |
| C5 | **`answer_permission`** (M8) | Closes the dead-scope asymmetry (F11) and unlocks `blocked`/`awaiting-review` emission. Route through `runGatedWrite` with **unconditional** human-confirm + TOCTOU recheck (never auto-answer from worker output). Detection (T8.1) Claude-only first | M | med | **P1** |
| C6 | **`get_changed_files`** (read-only) | Structured `[{path,+,−,status}]` from existing `gitDiff.ts` + `parseDiffStat` (lift the pure parser to a MAIN-safe util). No M6 dependency. Powers diff coloring/grouping. *Scope to the tool only — defer the redundant `canvas://board/{id}/diff` resource since `git_diff` already returns raw text* | M | low | **P2** |
| C7 | **`await_settled` event-driven refactor** | Replace the 1s busy-poll (F19) with `subscribeStatus` + `onResultSettled`, output-silence as fallback. *Ship only the refactor — drop the wire-register half (handoff_prompt/wait_for_all already cover the agent wait case)* | S | low | **P2** |

### 6b. Human-facing Command-board / palette commands

| # | Command | Rationale | Effort | Risk | Priority |
|---|---|---|---|---|---|
| H1 | **Orchestration palette section + canonical audit shortcut** (one PR) | Fills the `commandRegistry.ts:11` placeholder: "Open Command board", "View audit log", "Setup orchestration", "Sync agent CLIs", "Interrupt all workers". Move Ctrl+Shift+A into the drift-guarded keymap + `SHORTCUT_ROWS`. Fixes F3+F4 (top UX risks). All verbs route to gated/read-only paths | S | low | **P0** |
| H2 | **Test-connection after Sync** | New frame-guarded `orchestration:ping` → MAIN invokes `orchestrator_ping`; token never crosses to renderer; returns reachable/latency or error. Closes the silent-misconfig top risk (F15) | S | low | **P1** |
| H3 | **Attention Queue badge + panel** | Consume the live (unconsumed) attention feed: chrome badge + complementary jump panel. Ships M5-T5.4 value for `failed` today; richens with C5 | M | low | **P1** |
| H4 | **Cancel queued task** | `discardTask` on TaskCard for queued status; frees the cap slot; nothing spawned yet → no MAIN call/gate. Fixes F17 | S | low | **P1** |
| H5 | **Diff coloring** (TaskCard + Recap) | ~15-line pure span helper (+green/−red/@@ accent), functional color only, no library. Fixes F16. Pairs with C6 for per-file grouping | S | low | **P2** |
| H6 | **Empty-board orchestration-state guard** | When orchestration is off, the empty Command board explains the prerequisite + shows an Enable button (`orchestrationStore.enabled` already available). Fold into the H1 PR | S | low | **P2** |
| H7 | **Sync-modal copy fix (F14) + rebrand (F26)** | Make the ".mcp.json / always" row conditional/accurate; "Canvas ADE"→"Expanse" on the consent/trust surface | S | low | **P2** |

### 6c. Standalone MAIN fixes (ride along, not features)

- **F6** `'rejected'`→`'denied'` at `mcpOrchestrator.ts:503` + unit test — **P0** (forensic integrity, one word).
- **F7** audit the `configureBoard` shell/cwd path — **P1**.
- **F8** persist `provisionedDirs` to `userData` (atomic; load on boot) — **P0** (real stale-token fix).
- **F9** extract `McpCommand`/`PlanningOp`/`AuditEntry` to `src/shared/mcpTypes.ts` — **P0** (*must precede* any new command variant for skill/recipe dispatch).
- **F11** remove `SCOPE_ANSWER_PERMISSION` from `ORCHESTRATOR_SCOPES` until C5 ships — **P0**.
- **F13** write ADR 0010 (MCP transport security) — **P1**.
- **F18/F21/F22/F23/F20** hardening + comment fix — **P2**.

---

## 7. Prioritized build sequence

**Wave 1 — P0 foundation (parallelizable, mostly no deps):**
1. **H1** Orchestration palette + canonical audit shortcut (+ fold **H6**) — pure renderer.
2. **F5/C2-fix** spawnGroup sanitizer — *ship even if wiring slips.*
3. **F6** deny-label + **F7** config audit — MAIN one-liners.
4. **F9** `src/shared/` type extraction — de-risks everything downstream.
5. **F8** persist `provisionedDirs` — standalone security fix, precedes shipping more provisioning surface.
6. **S1** `registerPrompts` scaffold + **S7** e2e probe.
7. **C1** `canvas://app-model` wire + drift test; **C2** `spawn_group` wire; **C3** `write_result` `.max()`; **F11** drop dead scope — *one coordinated sibling-package + app release* (see dependency note below).

**Wave 2 — P0/P1 substrate + first value:**
8. **S2** canvas-ade primer (needs C1/C2 landed for accurate content; closes F25).
9. **S4** `review-pr` + **S3** `fan-out-and-compare` — the two flagship playbooks on S1.
10. **H2** Test-connection; **S6/Recipe launcher** (human templates).
11. **C4** `canvas://connectors` (unblocks cleaner relay/handoff guidance in the primer).
12. **F13** ADR 0010.

**Wave 3 — P1/P2:**
13. **C5** `answer_permission` (M8, Claude-only detection first) → then **H3** Attention Queue richens; **S5** `triage-attention`.
14. **H4** cancel-queued; **C6** `get_changed_files` → **H5** diff coloring; **C7** `await_settled` refactor.
15. **H7** copy/rebrand; remaining hardening (F18/F21/F22/F23/F20).

**Deferred:** M6 worktrees (needs a concrete start date — it gates M7 write tools, M9 merge, M10 stateless). Everything in Waves 1–3 is **pre-M6** by design.

> **Critical dependency note (corrects a repeated proposal claim):** the "zero new MAIN code" framing for C1/C2/C7 is wrong. `describeApp`/`spawnGroup`/`awaitSettled` live on the app's private `RunningMcp` facade, **not** on the package's exported `Orchestrator` interface (`dist/index.d.ts:195-285`). Each wire-registration is **three coordinated edits**: (1) add the method to the package `Orchestrator` interface, (2) bind it in `buildOrchestrator`, (3) register the tool/resource in `ServerFactory`. Sequence the **package release first**, then the app bump — it is a sibling-package + app change in lockstep, not a pure package patch.

---

## 8. Risks, open questions, and what to NOT build

### Killed proposals (and why)

- **`judge_outputs` (LLM-judge over N candidates)** — *dropped.* Speculative, downstream of two unbuilt things (fan-out + `get_changed_files`), adds a new LLM-egress path for a workflow no user has asked for. The human reading N diffs is fine for v1; revisit only if fan-out proves demand.
- **`canvas://tasks` + `claim_task` (task graph, M10 slice)** — *dropped/deferred.* Largest net-new MAIN subsystem for the least-validated demand at single-user-desktop scale; overlaps the existing kanban. **C4 `canvas://connectors`** is a better use of the same package-bump budget.
- **`set-up-feature-zone` playbook** — *dropped.* Once `spawn_group` is wired (C2), this is a single tool call; the pre-wire 3-call sequence belongs in the S2 primer.
- **`sequential-handoff` / `/canvas-handoff`** — *dropped.* Thin (a 2-tool sequence) and crippled because an agent can't enumerate cables — the C4 resource + the primer's cable-authorization section cover it better.
- **`/canvas-review-pr`, `/canvas-orchestrate`, `/canvas-status`, `/canvas-plan` (Claude-only `.md` skills)** — *dropped as standalone files.* Each duplicates a prompt-playbook or an in-app UI at a Claude-only layer. Their value survives **inside** S2/S3/S4/S5.
- **`/canvas-revoke` skill** — *dropped.* It band-aids a real security gap (F8) with a fragile agent-driven file-scanner that must track four config formats and edits user credential files. **Build the MAIN fix (F8 persistence), not the skill.**
- **`/canvas-connect` skill** — *folded.* Its verify step duplicates the in-app **H2** Test-connection; keep the connect/verify guidance as a primer section, not a fourth maintained file.
- **`await_settled` wire-register half** — *dropped.* Unjustified new surface; `handoff_prompt`/`wait_for_all` already cover the agent wait case. Keep only the poll→event refactor (C7).
- **`fan-out-and-merge` (the name)** — *renamed* to `fan-out-and-compare` (S3): no merge tool exists pre-M7 and the lethal-trifecta rule forbids auto-merge anyway.

### Open questions

1. **M6 start date.** Resolve the CLAUDE.md ("deferred post-MCP") vs `roadmap-mcp.md` ("M6 *is* the roadmap") ambiguity. Until then, document that `close_board` does **not** honor the dirty-worktree keep+prompt contract.
2. **`git_diff` tier.** Connected agents can't call it (orchestrator-only) — intentional, but it forces the `review-pr` playbook into a shell fallback. Is granting connected-tier read access a deliberate decision worth making?
3. **2026-07-28 stateless RC.** The package is stateful (`Mcp-Session-Id`); migration is deferred to M10 (unbuilt). The transport seam is isolated (`transport.ts`) but the future breaking change is tracked only in roadmap prose, not code.
4. **Recipe-template scope.** Should S6 templates be project-scoped (`canvas.json`) or global (`userData`)? The proposal favors `canvas.json` (additive, ADR 0007) for portability.

### Anti-overbuild verdict

The function-lens proposals trend toward minting new gated tools (task graph, judge, fan-out tools, await wire) ahead of demonstrated demand. The architecture already lets a **prompt-playbook compose shipped tools** to deliver the same workflow with **zero new attack surface**. **Prefer playbooks-over-tools until a playbook proves a pattern is hot enough to deserve its own first-class tool.** The genuine must-builds are small, foundational, and mostly pure-renderer or one-file MAIN fixes — not new agent capabilities.
