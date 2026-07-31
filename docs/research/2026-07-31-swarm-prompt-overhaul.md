
# Prompt Engineering for Orchestrator–Worker Swarms: Research Report

Scope: current best practice (2025–2026) for lead/orchestrator prompts, worker role briefs, task dispatch specs, and cross-turn state discipline — applied to the three prompt surfaces in this repo: `src/main/swarmPrompt.ts`, `src/shared/rolePacks.ts`, and `src/renderer/src/lib/commandDispatch.ts` (`DISPATCH_ENGINEER_SYSTEM`).

## 1. Principles

### (a) Orchestrator / lead prompts

**P1 — The lead coordinates and synthesizes; it does not do the work.** Anthropic's research-lead prompt states the role as "coordinate, guide, and synthesize — NOT to conduct primary research yourself," and terminates with an explicit stop rule: "when further research has diminishing returns… STOP FURTHER RESEARCH." An orchestrator prompt needs both halves — the identity and the stopping condition — or it either meddles or never converges. (Anthropic cookbook research-lead prompt; Anthropic multi-agent post.)

**P2 — Effort must be explicitly scaled to complexity, with numbers.** "Agents struggle to judge appropriate effort for different tasks," so Anthropic embeds explicit scaling rules: simple fact-finding = 1 agent / 3–10 tool calls; comparisons = 2–4 subagents; complex = 10+ with "clearly divided responsibilities" (their system once spawned 50 subagents for a trivial query without these rules). Opus-5-era guidance adds a damping form: "If one subagent can complete the task, use one rather than several, and keep spawn counts low." (Anthropic multi-agent post; Prompting Claude Opus 5.)

**P3 — The orchestrator prompt must name the worker catalog: what each worker does, what inputs it expects, what outputs it returns — and delegation is a routing decision over that catalog.** "The orchestrator prompt specifies which worker agents exist, what each does, what inputs they expect, and what outputs they must deliver." A routing decision is only as good as the category set: routing "works well for complex tasks where there are distinct categories that are better handled separately." A task class with no matching category is a *catalog* bug that no amount of orchestrator cleverness fixes. (MachineLearningMastery; Anthropic Building Effective Agents.)

**P4 — Parallel dispatches must be distinct and non-overlapping, and writes are the dangerous case.** Anthropic: "every subagent should have distinct, clearly separate tasks, to avoid replicating work"; short instructions caused subagents to "perform the exact same searches as other agents." Cognition's counterweight: "actions carry implicit decisions, and conflicting decisions carry bad results" — read-only parallel work is safe; parallel *edits* without shared context are how systems become fragile. (Anthropic cookbook; Cognition "Don't Build Multi-Agents.")

**P5 — Write rules at the "right altitude," and prefer judgment over absolutist bans on current models.** System prompts should be "specific enough to guide behavior effectively, yet flexible enough to provide strong heuristics" — neither brittle if-else scripting nor vague vibes. Anthropic deleted ~80% of Claude Code's system prompt for the newest models with "no measurable loss on coding evals"; the deleted mass was NEVER/ALWAYS bans that "restate taste the model already learned" and contradictions between layers. Keep hard product constraints, domain gotchas, and pointers; cut sermons. "More capable models follow conflicting rules more diligently into stupid places, or burn tokens resolving them." (Anthropic context-engineering post; Thariq @trq212 thread.)

### (b) Worker / subagent role prompts

**P6 — Scope a worker by *capability and posture*, not by one workflow's subject matter.** Claude Code's subagent model is "focused system prompts for specific domains" with tool restrictions enforcing posture ("read-only tools; Write and Edit are denied") — the *tools* define what the agent can't do; the prompt defines what it's *for*. Inflectra: role & scope should establish "what it is, what its job is, and where that job begins and ends" — but Thariq's unhobbling lesson is that scope drawn tighter than the capability (bans encoding one workflow) becomes the thing that breaks on the next workflow. (Claude Code sub-agents docs; Inflectra; Thariq thread.)

**P7 — A worker sees only its system prompt plus the delegation message — so the brief must be self-sufficient, and anything the worker must know must be restated in the dispatch.** "Each subagent starts with a fresh, isolated context window. It doesn't see your conversation history… Claude composes a delegation message that summarizes the task, and the subagent works from there." Corollary: if a rule must reach the subagent, "restate it in the prompt you give Claude when delegating." Minimal shared context is a feature: each worker "knows only what it needs for its job." (Claude Code sub-agents docs; MachineLearningMastery.)

**P8 — Give workers a graduated escape lane: report-with-caveats first, structured failure with a routing hint second, never silent drift.** Briefs should instruct "do not guess" and name exactly what's missing on failure — but a bare "failed" is a dead end. The practitioner pattern is degrade gracefully: an empty result is a valid result ("an empty findings list is a valid clean result"), a partial answer with low confidence beats a refusal, and a true scope mismatch should return a signal the orchestrator can *act on* (what capability was needed), not just a verdict. Explain the *why* behind constraints so the model generalizes instead of misfiring on the letter. (Claude prompting best practices; Inflectra; Anthropic multi-agent post.)

**P9 — Prefer interface/schema over prose for the report contract.** Thariq's myth #2: replace multi-page "here's how to call this" prose with "schema, enums, and validation errors." A named report tool with a JSON schema (status enums, typed refs) is a stronger contract than any paragraph, and Anthropic's ACI principle says to invest in that tool surface as much as the prompt. (Thariq thread; Building Effective Agents.)

### (c) Task dispatch specs

**P10 — Every dispatched task carries: objective, output format, context, and explicit boundaries — omitting them is the verified cause of duplication and gaps.** "Each subagent needs an objective, an output format, guidance on the tools and sources to use, and clear task boundaries." The cookbook lead-prompt expands the checklist: one core objective per subagent, expected output format, relevant background context, key questions, *suggested starting points/sources and tools*, and precise scope boundaries — with the aggregate test: "IF all the subagents followed their instructions very well, the results in aggregate would allow you to give an EXCELLENT answer." (Anthropic multi-agent post; cookbook research-lead prompt.)

**P11 — Dispatch instructions should state the goal and done-criteria, not a step script.** "Use outcome prompts, not procedure lists" — procedures break when a step fails; outcomes let the agent adapt. OpenAI's guide agrees from the other side for *routine* work: the dividing line is whether the subtasks are predictable (workflow) or not (agent). For coding workers dispatched into unpredictable repos, outcome + constraints wins. (MachineLearningMastery; OpenAI Practical Guide; Building Effective Agents.)

**P12 — Structure beats prose in the dispatch message; label the parts.** Separate instructions, context, and data with explicit structure (XML tags or labeled sections) so the worker can't confuse background for orders, and keep the trusted/untrusted boundary legible. (Inflectra; Claude prompting best practices.)

### (d) Context / state management across turns and confirm gates

**P13 — Context is a finite attention budget; the orchestrator must re-orient from authoritative state, not from memory of its own transcript.** "Context rot" means recall degrades as tokens accumulate; the fix is "lightweight identifiers" plus just-in-time retrieval — check the environment when you need the truth. For multi-window/multi-turn work Anthropic is prescriptive: "Review progress.txt, tests.json, and the git logs" — i.e., *re-read state before acting*. A confirm gate is exactly such a window boundary: any plan formed before the gate is stale after it. (Anthropic context-engineering post; Claude prompting best practices › multiwindow workflows.)

**P14 — Track run state in a structured, externally visible form, and keep it honest incrementally.** "Use structured formats for state data… use JSON or other structured formats"; agents should "summarize completed work phases and store essential information" outside the context window. In an orchestrator this means the *roster* (workers: id, role, state, current task) and the *plan* (items, owners, done-flags) are first-class state objects that the model reads and updates — not facts it tries to remember across turns. (Claude prompting best practices; Anthropic multi-agent post appendix.)

**P15 — Workers return condensed results; raw output never transits the coordinator.** Sub-agents "return condensed, distilled summaries (typically 1,000–2,000 tokens)"; heavy output goes "to a filesystem to minimize the 'game of telephone,'" with lightweight references passed back. (Anthropic context-engineering post; multi-agent post appendix.)

## 2. Critique of the three surfaces

### What is already right (keep all of this)

- **The four-field task spec** (`objective / context / boundaries / outputFormat` as *required tool args* in `dispatch_task`) is the strongest thing in the system. Matches Anthropic's verified finding nearly verbatim (P10), enforced at schema level (P9).
- **The effort ladder** (1 / 2–4 / 3–5 / 10+) matches Anthropic's published scaling rules (P2).
- **Escape hatches in every brief** ("call write_result with status 'blocked' or 'failed'… rather than guessing or drifting") implement the do-not-guess half of P8. Reviewer's "an empty findings list is a valid clean result" is textbook.
- **One-voice + structured reports** is exactly P15.
- **`reportSchema` as typed data per role** is P9 done right.
- **Write serialization, disclosed** is a sound answer to Cognition's conflicting-decisions problem (P4); the cap is honest (`writeRoleConcurrencyCap`).
- **The role catalog composed from packs by purpose** (`entryCondition` one-liners) matches P3 in *form*.
- **Terse lead voice, tense discipline** matches Opus-5 narration guidance.
- **Explorer brief's motivation clause** ("your answer returns into a busy orchestrator context…") is the context-behind-instructions technique (P8's "why").

### Violations and gaps

**V1 — Explorer is subject-scoped, not capability-scoped, and the catalog has a hole where research should be (→ incident 1).** Brief hardwires "Answer only the assigned where/how question **about this codebase**." One workflow's subject baked into a role identity — the over-tailoring P5/P6 warn against. Web-research goal had no correct routing target (P3); worker obeyed its letter and refused. Compounding: (a) on an empty project the role's subject vanishes with no degraded behavior; (b) bare `failed — out of scope` carries no routing hint (violates P8). Also `acceptance.statusMustBe: ['done']` scores a *correct* refusal as worker failure — incentive gradient points the wrong way.

**V2 — No worker-lifecycle state discipline in the orchestrator prompt, and no roster affordance in context (→ incident 2).** `composeSwarmSystem` is static and cached (`swarmChatIpc.ts` `cache_control`); nothing injects the live roster per turn. A `list_workers` tool exists (`swarmTools.ts:268`) but the system prompt *never mentions it*. Model's only knowledge of "mcp-researcher exists and is idle" is a tool-result several turns back, behind a confirm interruption — the context-rot + stale-plan condition P13 describes. Spawn-then-orphan is the predictable failure. No stated invariant connecting spawn to dispatch, no reuse rule, no idle-role-match-blocks-spawn rule.

**V3 — No anti-duplication / distinctness rule for parallel rounds.** Nothing requires a round's tasks be distinct and non-overlapping, or that each task's context say what the *other* workers own (P4, P10).

**V4 — No stop rule.** Effort ladder for starting work but nothing like "when further work has diminishing returns, stop and synthesize" (P1). Long runs will over-dispatch at the tail.

**V5 — `DISPATCH_ENGINEER_SYSTEM` is a second, divergent dispatch grammar.** Produces a single instruction blob — no boundaries, no output format, no context section — so the Command-board path fails P10 while the swarm path enforces it. Asserts "assume it can read/run/edit files" unconditionally — false for every `plan`-posture role. "Implied steps" nudges toward procedure lists over outcomes (P11).

**V6 — Minor altitude issues.** "RULES (all mandatory)" + ALL-CAPS register is what current models over-obey (P5). Four-field and one-voice deserve firmness; "No filler" and duplicated pause phrasing don't. Briefs ride every dispatch (`packDispatchPrompt`) — acceptable (re-anchors role) but argues for keeping briefs short; preserve in rewrite.

## 3. Recommendations

### 3.1 Role-brief TEMPLATE (sections, in order)

Every `systemPrompt` in `ROLE_PACKS` = six sections, in order (flowing sentences fine — single-line REPL collapse punishes headings; each sentence-group maps to one slot):

1. **Identity + posture** — one sentence: role name, read-only/write, arena ("the assigned working tree", "the resources this workspace exposes: code, docs, and the web"). Role focusing is the cheapest strong steer; posture up front lets later instructions be interpreted under it (P6).
2. **Mission, capability-scoped** — what class of work this role exists for, defined by *capability* (investigate/judge/build/decompose/research), never one subject ("this codebase") or one workflow. (V1 incident class; P5/P6.)
3. **Method defaults** — 1–3 sentences of *how*: breadth before depth, verify before done, terse findings over narrative — with the why where non-obvious. (P8 motivation; P11 outcome-flavored.)
4. **Scope limits (negative space)** — few load-bearing must-nots. Short; every ban must earn its place. (P4/P10 boundaries prevent duplication/gaps; P5 says bans beyond that are hobbles.)
5. **Report contract** — name the tool (`write_result`), status enum, each field with one clause. Mirror `reportSchema` exactly; schema is authority, prose is caption. (P9.)
6. **Escape lane, graduated** — (i) partial answer + caveats + `confidence: low` when answerable-but-thin; (ii) `blocked` naming exactly what's missing; (iii) `failed` **with routing hint** — one clause naming the capability the task actually needs. Never silent drift, never out-of-role work quietly. (P8; routing hint makes verdicts orchestrator-actionable.)

### 3.2 Role definitions to ship

**NEW: `researcher`** — fills the catalog hole (incident 1).
- Pack data: `tier: 'worker'`, `permissionMode: 'plan'`, `model: { tier: 'mid' }`, `isolation: 'none'`, `confirmPolicy: 'session-consented'` (read-only, Q4-legal), `entryCondition: 'answer a question from external sources — web, docs, references — and synthesize with citations'`.
- Brief:

> You are a Researcher: a read-only investigator. Answer the assigned question using any source available to you — web search, documentation, references, and files in this workspace — and synthesize what you find; never edit files or run write commands. Search broadly first, then go deep on the strongest sources; prefer primary sources, and note when sources disagree. Be terse: your answer returns into a busy orchestrator context — findings and conclusions, not a tour of your process, with each key claim tied to a source. Report via the write_result tool with status "done", a summary that directly answers the question, sources as a list of URL-or-path strings, open_questions for anything unresolved, and confidence of low, medium, or high. If the question is only partly answerable, answer that part with low confidence and say what's missing; if it needs capabilities you don't have (editing files, running the app), call write_result with status "failed" and name the capability needed.

- `reportSchema`: explorer's shape with `sources` replacing `refs`; keep `open_questions` + `confidence`.

**CHANGED: `explorer`** — capability-scoped, empty-project floor, routing-hint escape lane:

> You are an Explorer: a read-only recon scout for this workspace. Answer the assigned where/how question by locating, reading, and summarizing what actually exists here — code, configs, docs; never edit, never fix what you find, and do not expand into a broad audit. Be terse: your answer returns into a busy orchestrator context, so give findings, not narrative, and cite evidence as path:line. Report via the write_result tool with status "done", a summary that directly answers the question, refs as path:line strings for the key files, open_questions for anything unresolved, and confidence of low, medium, or high. If the workspace doesn't contain what the question assumes — including a new or empty project — that is itself the finding: report done, say exactly what is and isn't present, with low confidence if inference was needed. If the task actually requires sources outside this workspace or capabilities you don't have, call write_result with status "failed" and name what it needs (for web/library questions, that's a researcher).

Empty-project case explicitly a *done* with findings, not a failure. `failed` carries routing hint (P8).

**CHANGED: `builder`, `code-reviewer`, `planner`** — small edits:
- All three: append routing-hint clause to escape hatch ("…and, if the task is outside this role, name the capability it needs").
- `code-reviewer`: keep "prefer no finding over a speculative one" but add "Report every real problem you find at every severity — severity labels, not omission, are how importance is communicated." (Opus-5 literal-conservatism warning.)
- `planner`: no substantive change.

### 3.3 Orchestrator prompt changes (`swarmPrompt.ts`)

**(1) WORKER LIFECYCLE rule block:**

> - WORKERS ARE REUSABLE: a spawned worker is standing capacity, not one task's wrapper. Before ANY spawn, call list_workers and check for an idle worker whose role fits; if one exists, dispatch to it — do not spawn a duplicate. Spawn only when no idle role-match exists or the effort ladder genuinely calls for parallel capacity.
> - SPAWN COMMITS YOU TO DISPATCH: spawning creates capacity for a specific need — the next dispatch for that need goes to THAT worker id. Never leave a spawned worker idle with no task while spawning another; an orphaned worker is your bookkeeping error. After any confirm gate or denial, re-check list_workers before deciding to spawn — your memory of the roster is stale; the tool is the truth.

**(2) Tool-affordance: inject live roster snapshot into context every turn (LOAD-BEARING FIX; rule above is its seatbelt).** MAIN composes per orchestrator turn: `WORKERS: builder-1 (builder, busy: "migrate schema", planItem 2) · mcp-researcher (researcher, idle) · …` + `Plan: 2/5 ticked` — injected as system-reminder-style block in the *user turn*, NOT the cached system block (`composeSwarmSystem` is `cache_control: ephemeral`; per-turn roster there busts cache every turn). Makes orphan-spawn nearly impossible. `list_workers` stays the on-demand refinement. (P14.)

**(3) Distinctness rule:**

> - DISTINCT TASKS: in any round, every task must be clearly separate work — no two workers on overlapping ground. Each task's context names what the other in-flight workers own so no one re-does or collides with a sibling's work.

**(4) Stop rule:**

> - KNOW WHEN TO STOP: when the remaining plan items are done or further dispatches have diminishing returns, stop dispatching, synthesize what landed, and report. Do not spawn or dispatch to "make sure."

**(5) Catalog-gap rule:**

> - NO ROLE FITS: if a task matches no role's purpose, say so and ask the human — do not force it onto the nearest role. A worker's "failed — needs X" report is routing information: re-dispatch to the right role or surface the gap; do not re-try the same role.

**(6) Tone pass (low priority):** keep mandatory register on four-field/one-voice/human-gate; soften incidental ALL-CAPS; collapse duplicated pause lines.

### 3.4 Dispatch-spec changes

**Keep the four fields exactly.** Two additions:
1. Enrich `context` description (in `swarmTools.ts` + FOUR-FIELD rule): *"What the worker must know: background, key questions, suggested starting points/sources or tools, and what other in-flight workers own."*
2. Aggregate test tail on FOUR-FIELD rule: *"Write each spec so that if every worker followed its instructions exactly, the results together would answer the whole goal."*

**Rewrite `DISPATCH_ENGINEER_SYSTEM` to emit the four-field grammar** — keep forgiving `TITLE:` contract, then `OBJECTIVE:` / `CONTEXT:` / `BOUNDARIES:` / `OUTPUT:` labeled sections (parser change optional — labels alone structure the prompt per P12). Drop "implied steps" for "the goal and what 'done' looks like" (P11). Capability assumption conditional on posture: parametrize by `isWriteRolePack` — "assume it can read and search; it can edit and run only if its role writes."

**Acceptance semantics:** `statusMustBe: ['done']` should stop meaning "anything else is a defect" — orchestrator (rule 5) treats a routed `failed` as re-routing input; optionally host-side `'failed-with-routing'`.

**Brief delivery (no change, one guard):** single-line collapsed REPL prepend fine; budget ceiling ~120 collapsed words per brief.

## 4. Sources

1. MachineLearningMastery — Prompt Engineering for Agentic AI — https://machinelearningmastery.com/prompt-engineering-for-agentic-ai/ — four agent-prompt components, right altitude, context rot, outcome-over-procedure.
2. Thariq (@trq212) X post — https://x.com/trq212/status/2080710971228918066 — direct fetch 402-paywalled; content RECOVERED via search snippets + secondary write-ups (explainx.ai claude-5-context-engineering coverage, aiweekly.co, developersdigest.tech, Rohan Paul). Substance: ~80% of Claude Code system prompt deleted for newest models, no eval loss; unhobbling; rules→judgment; interface-over-few-shots.
3. Inflectra — AI Agent Prompt Engineering — https://www.inflectra.com/Ideas/Topic/AI-Agent-Prompt-Engineering.aspx — five-component structure, refusal/edge-case examples, prompting-as-reliability-engineering.
4. Anthropic — How we built our multi-agent research system — https://www.anthropic.com/engineering/multi-agent-research-system — four-part task spec, effort-scaling numbers, 50-subagent tale, duplication/gap failures.
5. Anthropic — Building Effective Agents — https://www.anthropic.com/engineering/building-effective-agents — orchestrator-workers pattern, routing needs distinct categories, ACI.
6. Anthropic — Effective context engineering for AI agents — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents — attention budget, JIT retrieval, 1–2k-token distilled summaries.
7. Claude Code sub-agents docs — https://code.claude.com/docs/en/sub-agents — fresh isolated context + delegation message, tool-enforced posture, restate rules in delegation.
8. Claude prompting best practices — https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-4-best-practices — motivation-behind-instructions, dial back aggressive language, multiwindow re-orientation, structured state.
9. Prompting Claude Opus 5 — https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5 — spawn damping, over-verification warning, literal conservatism in review prompts.
10. OpenAI — A Practical Guide to Building Agents (PDF; corroboration-only, recovered via summaries) — instruction best practices, manager pattern, guardrails/HITL.
11. Cognition — Don't Build Multi-Agents — https://cognition.com/blog/dont-build-multi-agents — actions carry implicit decisions; parallel reads safe, parallel edits fragile.
12. Anthropic cookbook — research lead agent prompt — https://raw.githubusercontent.com/anthropics/anthropic-cookbook/main/patterns/agents/prompts/research_lead_agent.md — delegation checklist, anti-overlap, diminishing-returns stop rule, count bands.

**Executive summary:** Bones are current-best-practice (four-field spec, effort ladder, typed schemas, one-voice, disclosed write serialization). Two real incidents trace to two violations: role scope drawn at subject level with a catalog hole (explorer/no-researcher), and zero worker-lifecycle state discipline across confirm gates with no ambient roster (orphan spawns). Fixes: six-section capability-scoped brief template with graduated escape lane ending in routing hint; new `researcher` pack + explorer that treats "project is empty" as a finding; orchestrator rules for reuse-before-spawn, spawn-commits-dispatch, re-check-roster-after-gates, distinct rounds, stop rule — backed by the load-bearing per-turn roster injection into the user turn (not the cached system block); `DISPATCH_ENGINEER_SYSTEM` unified onto four-field grammar with posture-aware capability claims.
