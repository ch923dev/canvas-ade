# Swarm mission feed — research + design proposal

**Task #15 · lane `feat/swarm-mission-feed` · base `858e00df` · 2026-07-31**
**Status: RESEARCH ONLY. This PR is docs-only. Implementation is BLOCKED until lanes #12
(`plan-strip-kanban`) and #14 (`swarm-prompt-overhaul`) merge.**

---

## 0. Origin and settled framing

The user saw a "BridgeSpace / BridgeSwarm" marketing demo (screenshot committed alongside this
report as `bridgespace-reference.png`): agents drawn as a node graph — coordinator centre,
builders/scout/reviewer around it, edges, status pills, a "Run mission" button — with a **MISSION
FEED** strip along the bottom.

The main-session verdict, accepted by the user and **not relitigated here**:

- **Node-graph view — REJECTED.** Our swarm topology is always a star (orchestrator → workers), so
  a graph carries no information a list doesn't; it competes for exactly the screen space PR #416
  just gave to docked live worker terminals; and canvas-in-canvas nesting is an awkward interaction
  model.
- **Mission feed — ACCEPTED.** A chronological inter-agent event timeline for the swarm board. We
  have the data but no timeline surface.
- **Secondary steal:** role + provider labels on worker status pills.

---

## 1. Headline findings

**1. We have less of the narrative than we thought.** The user's own example beat-sequence is
*spawned X → dispatched to Y → Y reported → reviewer gated*. Two of those four beats are not
durable data today:

| beat | status |
|---|---|
| spawned X | **emitted but never persisted** — `swarmTools.ts:620-625` pushes `workerSpawned` to the renderer and drops it. After a reload the run only knows workers that received a task (`swarmLedgerProject.ts:176-180`). The feed's own opening line is unrecoverable across a restart. |
| dispatched to Y | ✅ durable — ledger `assigned` (`swarmLedgerSession.ts:211-219`) |
| Y reported | ✅ durable — ledger `status` via `setTaskState` (`swarmLedger.ts:498-506`) |
| reviewer gated | ❌ **does not exist in any form.** There is no reviewer/acceptance-gate decision event in MAIN. `blockedTag` values `failing_check` and `dependency` are consumed in three places but **nothing ever sets them**; the only producer is `'lost'` (`swarmWatch.ts:268`, `:540`). `RolePackAcceptance.checks` is declared data-only (`rolePacks.ts:38-46`). |

The nearest real approve/deny record is the **dispatch gate** (human confirm on a write), which
writes to `mcp-audit.jsonl` in userData (`dispatchGate.ts:201-205` → `auditLog.ts:65-77`) — but it
carries **no `runId`** and is never pushed to the renderer.

**2. The good news: a durable event log already exists and is already the right shape.**
`SwarmRunLedger.events: SwarmLedgerEvent[]` with a gap-free `eventSeq` and an epoch-ms `at` on every
entry (`swarmLedgerTypes.ts:195-218`), 9 kinds today, persisted per run at
`<project>/.canvas/memory/run-<boardId>.json`. Its own header comment says:

> "The bounded event tail. Enough to count stalls and narrate; **not yet a full event log (D3)**."

The mission feed is plausibly that D3 item.

**3. It is not projected to the renderer at all.** `SwarmLedgerSnapshot` (`swarmLedgerTypes.ts:325-353`)
carries `runId, state, restored, createdAt, planBoardId, counts, planOwners, workers, triage,
mergeSequence` — **no `events`**. The renderer has zero access to a chronological event stream. A
mission feed is a genuinely new projection, not a re-render of existing state.

**4. No schema bump is needed, and bumping would be catastrophic.** `SWARM_LEDGER_VERSION = 1` is
**fail-closed on exact match** — `if (version !== SWARM_LEDGER_VERSION) return null`
(`swarmLedger.ts:210-213`) drops the *entire* run ledger, including for a **future** version. But
`coerceEvent` is **open-vocabulary** (`typeof o.kind === 'string'` passes anything through,
`swarmLedger.ts:198-204`), so **new event kinds are forward-safe with no bump**. New *top-level*
ledger keys are **not** safe — `coerceLedger` rebuilds field-by-field (`:222-243`) and silently
discards unknown keys on the next read+persist by an older build.

**5. There is no free vertical space on the swarm board — except in the chat column.** That single
geometric fact determines the placement recommendation (§5).

---

## 2. Method

Per the user's hard requirement, the bulk reading/searching was fanned out to **Opus subagents**;
this session synthesised and judged. Four concurrent recon agents:

| # | agent | scope |
|---|---|---|
| A1 | `code-recon-worker` (opus) | MAIN swarm event sources — `swarmTools.ts`, ledger, watcher, IPC, persistence, volume |
| A2 | `code-recon-worker` (opus) | Renderer swarm UI post-#416 — layout anatomy, dock, state plumbing, list precedents |
| A3 | `research-worker` (opus) | Prior art — agent-orchestration timelines, observability feeds, CI run logs |
| A4 | `code-recon-worker` (opus) | Sibling worktrees #12 / #14 — flip mechanism, dispatch grammar, conflict matrix |

then a fifth **Opus design-synthesis agent** given A1+A2+A3 as a fact sheet. Its proposal was
reviewed and merged into §5–§11 below with corrections noted inline.

**Correction made during synthesis:** the design agent flagged as its #1 open question whether the
60s watcher *appends* to the ledger (an overnight stall would then write ~480 events and evict the
run's whole history). A1's recon answers it: the watcher appends a `stall` event **once per
episode**, guarded by a ledger-resident check (`swarmWatch.ts:381-384`), and only *re-pushes* the
snapshot every tick (`:416`). **No flood. Question closed, not escalated.**

---

## 3. Event-source map

### 3.1 Durable — reaches `SwarmRunLedger.events[]`

| kind | produced at | payload | pushed? |
|---|---|---|---|
| `runCreated` | `swarmLedger.ts:381-384` (in `ensureRun`, fired only on the run's **first turn** from `swarmChatIpc.ts:365`) | `{title, at}` — title = the human's first prompt, clamped 500 | no (snapshot carries `createdAt`) |
| `taskCreated` | `swarmLedgerSession.ts` (task minting, ids `t<N>` at `:105-110`) | `{taskId}` | via snapshot |
| `assigned` | `swarmLedgerSession.ts:211-219` | `{taskId, boardId, role}` + the 4-field spec stored on the assignment `:192-205` | via snapshot |
| `status` | `swarmLedger.ts:498-506` (`setTaskState`) | `{taskId, state, provenance}` — `provenance: 'claimed' \| 'synthesized'` from `swarmTools.ts:855-872` | via snapshot |
| `blocked` | `swarmWatch.ts:268` | `{taskId, tag}` — **only ever `'lost'`** | yes |
| `stall` | `swarmWatch.ts:361-418` | `{taskId, count, silentMs}` — **once per episode**, not per tick | yes |
| `salvaged` | `swarmWatch.ts:254-262` | `{taskId}` | yes |
| `interrupted` | `swarmWatch.ts:465` (quit drain) | `{liveTasks}` | no (window dying) |
| `restored` | `swarmWatch.ts:547-553` | `{workers, results}` | yes |

Stamping is centralised: `append()` sets `seq` + `at` and "callers never do" (`swarmLedger.ts:395-401`).
Clock seam `deps.now ?? Date.now` at `swarmLedger.ts:284`, `swarmWatch.ts:205`,
`swarmLedgerSession.ts:128`.

### 3.2 Emitted to the renderer but **never persisted**

| moment | site | data in hand |
|---|---|---|
| **worker spawned** | `swarmTools.ts:620-625` | `{workerId, role, title}` — plus, in scope at that line: the full launch string (`:552-561`), worktree/branch (`:509`), OpenRouter routing (`:566-579`), dock host |
| spawn denied / worktree-alloc refused | `swarmTools.ts:536-547`, `:498-508`, `:585-589` | turn-act `phase:'denied'` only (`swarmChatIpc.ts:556-563`) |
| dispatch failed / denied | `swarmTools.ts:706-719` | ditto |
| batch-dispatch row declined | `swarmTools.ts:790-793`, reasons only in the tool `summary` string `:816-822` | dropped entirely |
| plan drawn | `swarmTools.ts:467-470` | sets `planBoardId`; **appends no event** (`swarmLedgerSession.ts:166-173`) |
| tool-call lifecycle | `swarmChatIpc.ts:522-563` | 2 pushes/use, phases `confirm\|running\|ok\|denied\|error`. The **only** record a tool ran |
| orchestrator turn start/end | `swarmChatIpc.ts:346-476` | history is MAIN memory only, session-scoped (`:88-104`) |
| consent grant/revoke | `dispatchGate.ts:284` / `swarmChatIpc.ts:797-806` | grant is stamped into the audit trail (`dispatchGate.ts:428-431`) |

### 3.3 Silently dropped — no event, no push

| moment | site |
|---|---|
| `tick_plan_item` | `swarmTools.ts:824-853` — plan progress is invisible to any feed |
| worker activity (status → running) | `swarmWatch.ts:342-348` — bumps `lastActivityAt` only |
| triage `dismiss` / `wait` | `swarmLedgerSession.ts:329-342` |
| worktree disposition (keep/commit/stash/discard) | `swarmChatIpc.ts:659-749` — narrates, appends nothing |
| mark-seen | `swarmChatIpc.ts:753-760` |
| **any reviewer/acceptance gate** | *does not exist* |

Also: every durable write from the tool executor is wrapped in `record()`, which swallows failures
with a `console.warn` (`swarmTools.ts:51-58`) — a disk error means a dispatch that happened but is
not in the log, with nothing on screen.

### 3.4 Tap points

| tap | site | sees |
|---|---|---|
| **durable choke** | `persist()` `swarmLedger.ts:338-347` — every mutation funnels through `update()` `:389-394` or `append()` `:395-401` | all of §3.1, with `seq` + `at` already stamped |
| **ephemeral choke** | `push()` `swarmChatIpc.ts:216-224` — every renderer-bound swarm message | all of §3.2 — **but also `kind:'delta'`, one push per LLM token (`:409-411`)** |
| gate decisions | `audit()` closure `dispatchGate.ts:201-205` — append-only, covers every branch | approve/deny, but no `runId`, never pushed |

§3.3 requires sprinkled taps no matter which choke is chosen.

### 3.5 Identity, labels, timestamps, volume

- `runId === boardId` (the swarm board's id, `swarmLedgerTypes.ts:221-224`); `workerId` = worker
  terminal board id; `taskId` = `t<N>`. All UUIDs, constrained by `isSafeId` (`safeId.ts:19-23`)
  because the ledger filename is `run-<boardId>.json`.
- **`role` is available** — ephemeral `SwarmRunCtx.workerRoles` (`swarmTools.ts:198`, written `:613`,
  rebuilt after restart `swarmChatIpc.ts:635-639`); durable `SwarmAssignment.role`
  (`swarmLedgerTypes.ts:138-141`) → projected `SwarmWorkerLedgerState.role?` (`:250-254`, filled
  `swarmLedgerProject.ts:180`). Display name + posture from `RolePack.name` / `.permissionMode`
  (`rolePacks.ts:52-54`, `:60`).
- **`provider`/model is NOT in MAIN swarm state.** It exists only inside the composed launch string
  — `composeRoleLaunch` → `['claude','--model', model]` (`swarmTools.ts:410-417`), overrides
  `['haiku','sonnet','opus']` (`:406`), tier aliases `rolePacks.ts:106`. The renderer-side proxy is
  the board's `agentKind` / `launchCommand`; `SwarmDock.tsx:149-151` already derives an identity
  label from them but feeds it only to an idle affordance.
- **Wire events carry no timestamp and no sequence** — `SwarmRunEvent` (`swarmRunEvent.ts:10-38`)
  and `SwarmTurnEvent` (`swarmChatIpc.ts:70-81`) have no `at`/`ts` member. A feed merging durable +
  ephemeral must define the interleave itself.
- **Volume.** Durable is low (~2-4 events/task + 1 per stall episode; hard cap 500/run). Ephemeral
  is not: per-token deltas, plus 2 act pushes + 1 full snapshot re-projection per tool call
  (`swarmChatIpc.ts:566`) + a `git status` kick per worktree (`:569`). Snapshots are full
  re-projections (`swarmLedgerProject.ts:543-575`), re-pushed every 60s while any task is stalled.
  Coalescing precedent: `commandFeed.ts:37` `COALESCE_MS = 120`, latest-wins.

### 3.6 Persistence surface

- File: `<project>/.canvas/memory/run-<boardId>.json`, atomic + fsync (`canvasMemory.ts:229-244`).
  "The ledger is the ONLY record that a run happened."
- Versioning is **its own**, decoupled from the canvas two-tier scheme (`SCHEMA_VERSION = 23` /
  `MIN_READER_VERSION = 23`, `boardSchemaVersion.ts:117`, `:163` — untouched by anything swarm).
  `SWARM_LEDGER_VERSION = 1`, fail-closed exact match, **no migration pipeline for this file**.
- Caps: `MAX_LEDGER_EVENTS = 500` (`.slice(-500)` on read `swarmLedger.ts:217-220` **and** in
  `clamp()` `:256-258` — two call sites), `MAX_RUNS_PER_PROJECT = 20` pruned by `lastActiveAt`.
  **Old entries vanish with no marker today.**

---

## 4. Prior art

Sources are cited in-line by product; every claim below came from primary docs unless marked.

**Taxonomy.** The shipped consensus is a **two-axis** model. Sentry: `type` drives colour + icon,
`level` drives **emphasis/de-emphasis only** and never gets its own column; a third freeform
`category` axis carries filtering. Kubernetes goes further and keeps severity to **two values**
(`Normal | Warning`), pushing all specificity into a short machine-readable `reason` verb
(`Pulling`, `Scheduled`). CrewAI's event bus is the most complete multi-agent taxonomy shipped
(~14 noun-categories × Started/Completed/Failed) and notably makes **human-in-the-loop** and
**agent-to-agent delegation** first-class categories rather than sub-types of "tool" — the A2A set
maps 1:1 onto spawned → dispatched → reported. OpenAI's Agents SDK likewise gives `handoff_span` and
`guardrail_span` their own types. MLflow and LangSmith both include an explicit `UNKNOWN`/default
member rather than forcing classification.

**Granularity splits by audience.** Span-level (log every tool call): LangSmith, Langfuse, Weave,
AgentOps, Braintrust. Milestone-level with detail collapsed: **GitHub Copilot coding agent**, where
"when Copilot delegates work to a subagent, the subagent's activity is now **collapsed by default,
with a heads-up display showing what it's working on right now**." The Copilot model is the closer
analogue for orchestrator + workers.

**Span-level demonstrably drowned, and vendors shipped remedies.** Langfuse added an *Aggregated
(default)* graph mode that "merges repeated steps by name into single nodes **with counters**"
because expanded agent runs were unreadable — and separately shipped a flat **Log View**, "a single
concatenation of all data in a trace's observations", so you can skim by scrolling and Cmd-F the
whole trace. That is a direct endorsement of flat + searchable over tree for our compact strip.

**Row anatomy.** `kubectl get events` is the canonical 5-column row and it is exactly
actor/verb/object/status/time: **LAST SEEN (relative elapsed, not wall clock)** · TYPE · REASON ·
OBJECT · MESSAGE. Sentry offers an explicit absolute-vs-relative **toggle** (relative anchored to
the first entry, negatives allowed); so does Grafana for precision. Temporal renders spanning events
as **bars** and instantaneous events as **points**, colours the span by outcome, and shows a retry
icon with attempt number. Buildkite replaced the running spinner with data: "a **ticking duration
and a bar that grows in real time**".

**Which agent an event belongs to — never colour alone.** Three documented mechanisms: avatars +
spatial "desks" (AgentGUI), collapsed sub-stream with a live HUD (Copilot), lanes (Temporal).
AgentOps colours by *event type*, not by agent.

**Grouping / noise.** Buildkite's three-state group syntax is the most explicit noise contract
anywhere — `---` collapsed (default) / `+++` expanded / `~~~` collapsed **and dimmed** — plus
**auto-expand-on-failure** (`^^^ +++`), sticky headers that hand off, and "the group that's
currently running expands automatically… when the job moves on, it folds back." Kubernetes
aggregates repeats with the same `reason + involvedObject` into a **series** with a `count` and
first/last timestamps. Linear "groups similar consecutive events and collapses older activity",
anchoring on the human-authored comment. Grafana ships four **dedup modes** (None / Exact / Numbers
/ Signature). GitHub Actions' `::endgroup::` takes no arguments, which **permanently prevents
nesting** — bake a group id into the close marker if you ever want it.

**Live-follow.** Grafana's live tail is the best-documented contract: new rows arrive with a
**fading contrasting background so you can track what is new**; controls are Pause / Resume / Stop;
and **scrolling the view pauses tailing**. The documented pitfall (Grafana issue #29505) is that
scroll-pause without a loud indicator reads as a bug — "it might seem that live tailing is broken
because no new logs are coming." The opposite failure is GitHub Actions' unconditional pin-to-bottom,
which users complain **scrolls the run's own controls (Re-run jobs) out of view**. The same
stop-autoscroll-on-scroll-up bug class is open in OrbStack #914, Portainer #12459, Buildbot #3165 —
and Claude Code #53435.

⚠️ The floating **"N new / jump to latest" pill could not be verified in any first-party product
documentation** (the research agent flagged this explicitly). Treat it as common practice, not as a
cited pattern — which is why §8 specs a **bar**, not a pill.

**Empty / early / overflow.** Copilot deliberately surfaces bootstrap steps "so you can understand
what's happening while you wait" — the feed's first content is setup milestones, not an empty box.
Temporal keeps total run duration on the top row so elapsed stays legible during dead air. Caps:
Sentry `maxBreadcrumbs` default **100** in a ring buffer; GitHub Actions shows the previous **1,000
lines** of backscroll and truncates with a **download link and an explicit banner** rather than
dropping silently; Datadog Live Tail **samples uniformly at random** when volume is too high and
says so. NN/g on empty states: without feedback "the user cannot know whether there truly are no
details, whether an error occurred, or the system is still processing."

**Anti-patterns.** AgentGUI (arXiv 2607.26300) states the core criticism plainly: a long-running
agent leaves "a **messy transcript of interleaved reasoning steps, tool calls, and file accesses**",
and "**spending time studying agent traces partly defeats the time-savings promised by
delegation**". Decomposing into a small number of semantic classes with distinct visual cues
measured **38% faster comprehension (90s vs 145s, p=0.023) and 93% vs 80% accuracy** — the single
strongest empirical argument for a tight taxonomy. *(Single-source preprint, their own user study.)*
GitHub Actions' log search highlights matches but does not navigate to them and caps at the first
100 hits with no indication there are more. Streaming feeds that reorder steps or stamp all
backscroll with the same timestamp destroy trust — **do not synthesize timestamps for replayed
history.**

---

## 5. Placement

### 5.1 The geometry

Board default **1180 × 660** world px (`boardDefaults.ts:28`), minus a 34px `BoardFrame` titlebar
(`browserLayout.ts:27`), minus a ~65px `.sw-head` ⇒ **`.sw-body` = 561px tall**.

`.sw-body` is a grid whose template is set inline from the host (`SwarmBoard.tsx:291-297`):
`gridTemplateColumns: ${chat}px 6px 1fr`, `gridTemplateRows: '1fr 6px auto'`.

- `.sw-chat` — col 1, **`grid-row: 1 / 4`** (spans *all* body rows), default 300px wide × 561 tall.
- `.sw-canvas` — col 3 row 1, the **only** elastic region: `.sw-rail` 208px + `.sw-vp` 666px
  (the docked xterms from #416). Height = 561 − 6 − 196 = **359px**.
- `.sw-needs` (triage) — col 3 row 3, inline height 196px.
- Clamps (`useDockLayout.ts:15-19`): `chat {180,560,300}` · `rail {150,420,208}` · `triage {84,340,196}`.
  `dockLayout` is optional + default-at-read ⇒ **adding a key needs no `SCHEMA_VERSION` bump**
  (`boardSchema.ts:435-436`).

**There is no free vertical space, and no region has a collapse affordance.**

### 5.2 Recommendation: split `.sw-chat` vertically — transcript above, feed below

| region | before | after |
|---|---|---|
| `.sw-chat` transcript | 300 × 561 | 300 × **335** (`flex:1`) |
| new `DockDivider axis="y"` | — | 300 × **6** |
| new `.sw-feed` | — | 300 × **220** (`flex:none`) |
| `.sw-canvas` / `.sw-vp` (#416 terminals) | 874 × 359 | **unchanged — 0px cost** |
| `.sw-needs` | 874 × 196 | **unchanged** |

Two reasons, in order of weight:

1. **It is the only placement that costs PR #416 nothing.** `.sw-chat` spans `grid-row: 1 / 4` and
   is structurally independent of the canvas column. Every other in-body option bills the 359px
   `.sw-canvas`, which is the docked terminals. The brief's stated objection to the node-graph view
   was precisely that it "competes for the screen space PR #416 just gave to docked live worker
   terminals" — a feed that does the same thing would inherit the objection.
2. **On the merits, the feed is the structured form of what the transcript narrates in prose.**
   They are near-duplicates; the transcript is the verbose one. Taxing it is coherent, not arbitrary.

**New key `dockLayout.feed`, clamp `{min: 24, max: 420, default: 220}`.** Min 24 = header only, with
a **snap band**: a drag settling below 96px snaps to 24, releasing above 96 restores the last real
height. That gives the swarm board its first collapse affordance using only the size key — no new
schema field. Collapsed, the 24px header becomes a ticker showing the latest event (Copilot's live
HUD).

**Expansion = a third face on lane #12's flip**, via the cheap option: keep `useTerminalFlip`'s
`flipped` as front-vs-back (zero hook change, zero blast radius across TerminalBoard / CommandBoard)
and add board-local **`backFace: 'kanban' | 'feed'`** selecting which back face renders inside #12's
existing `{flip.flipped && …}` block. The back face grows a 32px header with `[ Plan ] [ Feed ]`
tabs. This reuses `CommandRecapView`'s exact shape — a flip back face that is literally "NOW +
TIMELINE, newest-first, with per-row expanders" — the closest analogue that already ships.

`backFace` should be **session-only Zustand**, not a persisted board field, so the feature needs no
schema bump at all (scene/session split discipline: ephemeral session state never routes into a
board patch key).

### 5.3 Fallback A — a 28px 4th grid row in `.sw-body` (ticker only)

Rows become `1fr 6px auto(196) 6px auto(28)`, and **`.sw-chat` must change `grid-row: 1 / 4` →
`1 / 6`** or the transcript stops short of the new row. Cost: `.sw-canvas` 359 → **325px**, so a
dock pane's xterm goes 327 → 293px (≈18 lines at 16px). Tolerable at 28px, **not viable at any
expanded height** — at 160px the xterm drops to ~161px / ~10 lines. Fallback A is a ticker and
nothing more; expansion still goes on the flip face.

### 5.4 Fallback B — absolute overlay drawer (only if #12 slips)

`position:absolute; inset: 0 0 0 306px` over `.sw-canvas` + `.sw-needs`. Zero layout cost, terminals
stay mounted (visually covered, not unmounted). Rejected as primary only because it is a *new*
interaction pattern with fresh pointer-capture / focus questions over live xterms, whereas #12
already solved exactly that (`pointerEvents:'none'` + `isolation:'isolate'`, citing "the
TerminalBoard lesson"). Reuse beats invent.

### 5.5 Rejected

- **A `.sw-root` sibling strip below `.sw-body`** — strictly worse than fallback A: for the same
  height it taxes *two* regions (chat −H **and** `.sw-canvas` −H), because the chat lives inside
  `.sw-body`. One tax beats two.
- **Feed under the rail (inside `.sw-canvas`, 208px)** — 208px leaves ~74px for verb + object after
  elapsed/glyph/actor. Dead on arithmetic, and it shrinks the rail cards.
- **Feed replacing the chat behind a tab** — hides the primary interaction surface. The split gives
  you both.

---

## 6. Event taxonomy

**Two axes.** `type` → glyph + colour. `severity ∈ normal | attention | problem` → **emphasis only**,
never its own column (`--text-2` normal; `--text-1` + a 2px `--accent`/`--err` left bar for problem;
`--text-3` for chatter). Third freeform axis for filtering = `workerId`. Every row carries a short
uppercase machine verb (the k8s `reason`) — that is the thing you skim.

**The cut line:** *a feed row exists iff the event changed the run's shared state or required a
human decision.* Anything describing one agent's internal work belongs to that agent's docked
terminal, which is right there on the same board. This is the AgentGUI finding operationalised.

| # | feed row kind | source | new durable kind? | severity | glyph | REASON | compact copy (≤24ch) |
|---|---|---|---|---|---|---|---|
| 1 | `run.created` | ledger `runCreated` | — | normal | `+` `--text-3` | `STARTED` | `Run started` |
| 2 | `worker.spawned` | **dropped** `swarmTools.ts:620-625` | **`workerSpawned`** | normal | `+` `--text-3` | `SPAWNED` | `Builder-1 spawned` |
| 3 | `task.created` | ledger `taskCreated` | — | normal | `+` `--text-3` | `QUEUED` | `T-04 queued` |
| 4 | `task.assigned` | ledger `assigned` | — | normal | `→` `--accent` | `DISPATCHED` | `T-04 → Builder-1` |
| 5 | `worker.working` | ledger `status` (working/idle/needs-input) | — | normal · **chatter** | `·` `--text-3` | `WORKING` | `Builder-1 working` |
| 6 | `worker.reported` | ledger `status` (done) | — | normal | `✓` `--ok` | `REPORTED` | `Builder-1 reported` |
| 7 | `worker.failed` | ledger `status` (error) | — | **problem** | `✕` `--err` | `FAILED` | `Builder-1 failed` |
| 8 | `worker.blocked` | ledger `blocked` + tag | — | **attention** | `!` `--warn` | `BLOCKED` | `Builder-1 blocked` |
| 9 | `worker.stalled` | ledger `stall` | — | **attention** | `!` `--warn` | `STALLED` | `Explorer-2 stalled` |
| 10 | `worker.salvaged` | ledger `salvaged` | — | normal | `↺` `--text-3` | `SALVAGED` | `Explorer-2 salvaged` |
| 11 | `run.interrupted` | ledger `interrupted` | — | **attention** | `⏸` `--warn` | `PAUSED` | *(seam, §9)* |
| 12 | `run.restored` | ledger `restored` | — | normal | `↺` `--text-3` | `RESTORED` | *(seam, §9)* |
| 13 | `plan.ticked` | **dropped** `swarmTools.ts:824-853` | **`planTicked`** | normal | `✓` `--ok` | `PLAN` | `Plan 4/8 · <item>` |
| 14 | `run.refused` | **dropped** — spawn-denied / worktree-refused / dispatch-denied | **`refused`** (one kind, `subject:'spawn'\|'dispatch'\|'worktree'`) | **problem** | `✕` `--err` | `REFUSED` | `Explorer-2 spawn denied` |
| 15 | `gate.decided` | `dispatchGate.ts:201-205` → `mcp-audit.jsonl` (**no runId**) | **`gateDecision`** (pointer only) | normal / **problem** on deny | `⚑` `--accent`/`--err` | `APPROVED`/`DENIED` | `you approved pty.ts` |
| 16 | `human.acted` | **dropped** — triage dismiss/wait, worktree keep/commit/stash/discard | **`humanAction`** (one kind, `action` verb) | normal · **chatter** | `·` `--text-3` | `DISMISSED`/… | `you dismissed stall` |
| 17 | `log.truncated` | synthetic, written by the 500-clamp | **`truncated`** | normal · **chatter** | `⋯` `--text-3` | `TRUNCATED` | `1,204 events dropped` |

**Six new kinds, no version bump.** Three refusal cases collapse into one `refused` kind and six
human actions into one `humanAction` kind specifically to hold the count down.

**Must become durable** (the feed is nonsense without them): `workerSpawned` (the feed's opening
line, today unrecoverable across restart), `planTicked` (carries the `4/8` progress narrative the
reference screenshot's counter depends on; volume = plan length, ~8-20/run), `truncated` (makes
overflow honest, §9).

**Should:** `refused` — the record of a thing that *didn't* happen is the one thing nobody can
reconstruct later, and volume is ~0-3/run. `gateDecision` — the only human approve/deny in the run.

**Nice, cut first if the slice is too big:** `humanAction`.

**Must stay ephemeral forever:**

- `kind:'delta'` — one per LLM token. Never a row, never persisted.
- **Tool-call lifecycle** (`swarmChatIpc.ts:522-563`) — unbounded per worker × N workers. This is
  exactly the `commandFeedTypes.ts:11-16` rule: *"High-frequency N-worker status must NEVER be a
  durable content write."* It feeds the **rail-card live HUD** and the collapsed-header ticker and
  nothing else. Only the `denied` phase graduates, and it graduates as `gateDecision`.
- All derived rows: idle-gap rows, the closing summary, `×N` counts, truncation copy.

**Note for lane #14:** it adds a 5th role pack, **`researcher`** (`rolePacks.ts:277-316`). `role` is
carried as a bare `string` on `SwarmWorkerLedgerState.role`, so no type change is needed — but any
role→glyph/label map must enumerate **five** roles, not four. (This design deliberately does not
colour rows by role, so the exposure is small.)

---

## 7. Row anatomy

### 7.1 Timestamp: relative-to-run-**start**, static, `mm:ss`

Not relative-to-*now*. Relative-to-start is a **frozen delta** computed once per row — it never
ticks, never re-renders, never needs a 1Hz timer touching 200 rows. Matches `kubectl get events`'
LAST SEEN semantics without the cost.

**Toggle: yes** — one click on the elapsed value in the pane header swaps the column to `HH:MM` wall
clock. It earns its keep because you correlate feed rows against terminal scrollback, which is wall
clock.

**Restore correction (judgment call over the synthesis).** The head's run timer is renderer session
state (`SwarmBoard.tsx:79-83`, 1s interval while `run.startedAt !== null`), not `ledger.createdAt`.
So after a restore the header timer restarts while a `createdAt`-anchored feed would read `1447:22`
— they would disagree, which is worse than either choice alone. Rule: **once a run's event list
contains a `restored` event, the feed defaults to `HH:MM`** and elapsed becomes the opt-in. Within a
single session, elapsed is the default.

### 7.2 Compact row (300px column) — 22px

```
│8│2│  34   │6│10│6│    62      │6│      132 → 160 max        │6│
 pad ▏ 04:12    →   Builder-1      dispatched T-04           [×4]
     ↑           ↑     ↑                    ↑                  ↑
  2px severity  glyph  actor (mono 10px,  verb + object     count/dur
  bar, reserved  type   ellipsis)         --text-2 11px,    --text-3 9px
  (problem only) hue                      one line          right, 0–28px
```

`line-height: 22px`, no vertical padding, **no per-row border, no zebra** (calm). Hover =
`--surface-raised`. 132px ≈ 22-24 chars at 11px, hence the **short phrasing** column in §6 — two
phrasings per kind, authored deliberately; the full phrasing lives on the flip face.

220px pane = 24 header + 20 facets + **176 body ≈ 8 rows** (7 while the 20px jump bar shows).

### 7.3 Full row (flip face, 1180px) — 22px

```
│12│2│ 46 │8│10│8│   96    │8│    96    │8│      ~640 1fr       │8│ 64 │8│ 56 │8│32│12│
  pad ▏ 04:12   →  Builder-1  DISPATCHED  T-04 wire the ledger…   T-04   8m44s  ×4
                    actor +    REASON       full message         object   dur  count
                   role pill  mono 10px                           mono
                              uppercase --text-3
```

### 7.4 "Which agent" — text and linkage, never hue

Prior art is unanimous that colour-by-agent doesn't scale (AgentOps colours by *event type*;
Temporal uses lanes; Copilot uses a collapsed sub-stream + HUD).

1. **The `--mono` actor name is always present** — it is the primary carrier.
2. **A bare role pill, flip face only**: new `.sw-role--bare` — same `--mono` 9px uppercase `.06em`
   `--text-3` `max-width:76px` as `.sw-role`, but **no border and no `padding: 0 5px`**. 40 bordered
   pills on screen reads as chrome, and "functional only" forbids it. A *new* class means `.sw-role`
   itself is untouched ⇒ zero regression risk for the rail.
3. **Cross-highlight instead of colour**: hovering a rail card or dock pane head dims every feed row
   not authored by that worker; clicking filters (shared state with the facet row, §8).

The 76px cap needs no change — `INTEGRATOR`/`RESEARCHER` are 10 chars ≈ 54px at 9px mono.
**Compact rows render no role pill at all** — no room in 132px, and the role is one glance away on
the rail card. That is the correct resolution of the "the name deliberately wins leftover space"
tension noted at `swarm.css:685-687`.

### 7.5 Expander

Click a row → expands in place to **max 88px** (4 × 22): full message, object path, and for
`REPORTED` rows the report's first ~240 chars in `--mono` 10px on `--inset`. **One at a time**
(`CommandRecapView` precedent, "one-at-a-time keeps the overlay compact"). Expanding **detaches**
live-follow — auto-scroll would yank the thing you are reading.

---

## 8. Noise control

**Milestones vs Everything.** Default: Milestones in the compact pane, Everything on the flip face.
Non-milestone = exactly two kinds: `worker.working` and `human.acted`. A 2-of-17 exclusion sounds
pointless until you notice those two are the only ones whose volume scales with *time* rather than
with *work* — so the toggle matters exactly when it matters (5 workers churning statuses) and is a
no-op otherwise. `plan.ticked` stays **in** milestones: it is the single most legible progress
signal in the run.

**Repeat collapsing (k8s series).** Collapse consecutive rows sharing `(kind, workerId, reason,
object)` within a **90s window** into one row with `×N`. Timestamp shown = the **first** occurrence;
the expander shows `first → last`. Default ON, `☑ Collapse repeats` on the flip face turns it off.
Collapsing is a render-time `useMemo` grouping, **never a mutation** — the ledger keeps every event,
so `×N` is derived and un-collapsible.

**Per-agent facets.** A 20px strip below the header, rendered **only when >1 worker exists**:
`All · B1 · E2 · R3 …` at `--mono` 9px, `overflow-x:auto` like `.sw-plan`. Single-select (click
again = All) — multi-select is not calm. **The facet state and the rail card selection are the same
piece of board-local state**, so clicking a worker card in the 208px rail filters the feed. Highest
value-per-line in the design.

**5 workers emitting at once.** With deltas and tool lifecycle structurally excluded (§10), the true
worst case is ~5 events inside 200ms (five simultaneous dispatches):

1. Render from one array **sorted by `eventSeq`** — simultaneous arrivals are deterministic, not
   arrival-ordered.
2. **Batch-commit at ≤10 Hz** — coalesce into a ref, flush on rAF ⇒ 5 arrivals = 1 render
   (`commandFeed.ts:37` `COALESCE_MS = 120` is the in-repo precedent).
3. If one flush adds **>12 rows**, skip the per-row new-highlight entirely and flash the jump
   affordance instead — a wall of fading backgrounds is worse than none.
4. **Virtualize above 200 rows** with `lib/virtualizer.ts` `windowRange` (uniform-height math —
   exactly its assumption). Uniformity is preserved by forcing seam and gap rows to 22px too; the
   single open expander is the one exception, handled by offsetting rows after it by
   `(expandedH − 22)`. `react-window` is unavailable — a worktree cannot `pnpm install`
   (`osr/virtualRows.ts:5-8`).

---

## 9. Live-follow, empty, overflow

### 9.1 Follow contract

Reuse the precedent already in the file being edited (`SwarmBoard.tsx:85-91`):
`distanceFromBottom = scrollHeight − scrollTop − clientHeight`.

| state | rule |
|---|---|
| **Pinned** (default) | after each batch flush, `scrollTop = scrollHeight` |
| **Detach** | any user scroll leaving `distanceFromBottom ≥ 80` ⇒ `pinned = false` (Grafana: scrolling pauses tailing) |
| **Re-pin** | scrolling back to `distanceFromBottom < 24` ⇒ auto re-pin. The asymmetry (80 out / 24 in) is deliberate hysteresis so a 1px wheel tick cannot flap the state |
| **Expander open** | implicit detach; closing restores the prior pin state |
| **Flip face** | independent scroller, always mounts pinned — sharing pin state across two viewport heights is confusing |

**Detached must be loud** — the Grafana #29505 lesson. Two simultaneous signals:

1. The header live dot flips from filled `--ok` to hollow `--warn`; its label goes `Live` →
   `Paused · 7 new`.
2. A **20px full-width bar pinned to the bottom-inner edge** of the pane (a sibling of the scroller,
   `flex:none`, 1px top `--border-subtle`, `--surface-raised`): `↓ 7 new events`. A **bar, not a
   floating pill** — the pill pattern could not be verified in any first-party docs (§4), and a bar
   is unambiguous and only costs 20px while detached.
3. **When detached with zero new events the bar still renders**, reading `↓ Latest`. Without it, a
   user who scrolled up during a quiet stretch has no way to know they are detached — that *is*
   #29505.

**Auto-scroll can never displace a control — structurally, not by tuning.** Every control (live dot,
Milestones/Everything, facets, search, timestamp mode, `4/8`, run elapsed) lives in the 24px header
**above** the scroller; the jump bar lives **below** it. The scroller contains rows and nothing else.
That answers the GitHub Actions complaint by construction.

**New-row highlight** (Grafana live tail): each appended row gets
`background: color-mix(in srgb, var(--accent) 12%, transparent)` fading to transparent over 900ms via
a `data-new` attribute. `prefers-reduced-motion` → no fade, instead a 2px `--accent` left bar
persisting 3s. **Never animate the initial backfill** — only rows whose `eventSeq >` the high-water
mark captured at mount.

### 9.2 Empty / early

**Pre-run:** one centred `--text-3` 11px sentence — *"The mission feed records every spawn,
dispatch, report and stall in this run. Start a mission to begin."* — plus a dimmed `0 events`.
(The reference screenshot's own empty state is an explanatory sentence + a `0/8` counter; NN/g
endorses exactly this.)

**Early / bootstrap** (the Copilot lesson — don't show an empty box while people wait). The moment
the orchestrator's first turn begins, rows appear before any worker exists:

```
00:00  +  —   STARTED    Run started — ship the mission feed
00:01  ·  —   PLANNING   Orchestrator drafting the plan…      ← ephemeral, replaced in place
00:12  ✓  —   PLAN       Plan drafted — 8 items
```

The `PLANNING` row is the one ephemeral row in the design — sourced from the chat stream, replaced
(not appended-to) when the plan lands.

**Header always carries the run summary:** `● Live   Milestones ▾   ⌕   4/8 · 12:41`. The `4/8`
duplicates the `.sw-plan` chip strip on purpose — the flip face has no `.sw-head`.

**Idle gaps** (Temporal's always-legible elapsed). After >60s with no event, render a derived gap
row (padded to 22px for virtualizer uniformity): `— 4m quiet —`, `--text-3` 9px. Scrollback then
reads honestly and the elapsed axis never lies.

**Seams for discontinuities.** `interrupted` and `restored` do **not** render as normal rows — they
render as a full-width hairline with a centred inline label:

```
──────────────── session restored · 3 workers rehydrated ────────────────
```

A restore means the app was closed; that is a chapter break, and chapters are what make a 500-event
log skimmable.

### 9.3 Overflow — fix the silent drop

Today `.slice(-500)` drops the oldest with **no marker**, in **two places** (on read
`swarmLedger.ts:217-220` and in `clamp()` `:256-258`).

*Durable half:* a `droppedCount` **top-level ledger key is impossible** — `coerceLedger`'s
field-by-field rebuild silently discards unknown top-level keys. So the marker is itself an **event**
of new kind `truncated`, carrying `{droppedCount, throughSeq, throughAt}`, held at index 0. Exactly
one may exist; the clamp **updates it in place** (accumulating `droppedCount`) rather than appending
— i.e. `[marker, ...rest.slice(-(MAX-1))]`, mirroring the transcript's own `.slice(-(MAX-1))`
precedent (`swarmStore.ts:157-161`). Note `coerceEvent` requires `seq >= 0 && at >= 0`, so the marker
must carry a real (lowest) `seq` to sort first.

*Render half:* the first row becomes, non-expandable, `--text-3`:

```
⋯  1,204 earlier events dropped — log capped at 500 (through 03:12)
```

**Post-run:** derive (don't store) a closing row from the run's terminal state — Temporal's "total
duration on the top row" moved to the bottom, where the eye already is after following a tail:

```
12:41  ✓  —   COMPLETE   8/8 plan items · 5 workers · 2 stalls · 1 salvage
```

---

## 10. Data plumbing

**The single most important architectural call:**

> **The feed subscribes to the ledger, not to the chat stream.**

The live source is emitted from the **durable append path** (`swarmLedger.ts:395-401` — the same
choke that stamps `eventSeq` + `at`), **not** from `push()` (`swarmChatIpc.ts:216-224`). Consequence:
`kind:'delta'` — one per LLM token — is not *filtered out* of the feed, it is **structurally
incapable of reaching it**, because deltas never touch the ledger. Volume is then the ledger's own
~2-4 events/task.

### 10.1 Live path — new `swarm:runEvent` variant `kind:'feed'`

```ts
{ kind: 'feed', boardId, events: FeedWireEvent[] }      // always an array ⇒ batching is native
FeedWireEvent = { seq, at, kind, workerId?, taskId?, reason, message, object?, severity? }
```

- **Carries `seq` and `at` explicitly**, fixing "wire events carry no timestamp and no sequence"
  (§3.5). MAIN stamps them from the durable value. **The renderer must never stamp `Date.now()` on
  receipt** — after a restore, snapshot-sourced and live-sourced rows would then disagree about the
  same event's time. (This is the GitHub Actions "all backscroll shares one timestamp" trust bug,
  §4.)
- Added in **both** `src/main/swarmRunEvent.ts` **and** the hand-mirrored `src/preload/swarm.ts:27-49`
  ("Payload shapes MIRROR … keep in lockstep", `swarm.ts:8-9`). Cheap insurance: **a unit test
  asserting the two discriminant unions have identical `kind` sets** — the mirror is hand-written,
  so nothing else catches drift.
- Attach point: the `onRunEvent` chain, `useSwarmEvents.ts:90-117`, a new `kind === 'feed'` branch
  beside the `kind === 'ledger'` branch at `:104-106`.

### 10.2 Backfill path — additive-optional on `SwarmLedgerSnapshot`, cursor-gated

Add **`events?: SwarmLedgerEvent[]`** and **`eventHead?: number`** — the exact `planHolders`
precedent from lane #12 (additive-optional, the snapshot has no `version` field at all, no bump).

The objection is real: ledger pushes are **full re-projections** on every tool round, every 60s
watcher tick while stalled, and on rehydrate — re-sending 500 events at that cadence just relocates
the flood. So:

- **Every push carries the cheap `eventHead` scalar; `events` is populated only when the renderer
  needs backfill.** MAIN tracks `lastPushedSeq` per `(webContents, boardId)` and sends only
  `seq > lastPushedSeq`, or the full array when it has no record (first push after mount/reload).
- The renderer self-heals: if `eventHead > max(local seq)` it requests one new
  `swarm:ledger:refill(boardId, sinceSeq)`.
- *Simpler fallback if that statefulness is judged not worth it:* send the full `events` array only
  when `eventHead` changed, renderer replaces wholesale (~60-100 KB at the 500 cap — wasteful but
  correct). **Pick deliberately; don't drift into it.** (Open question §12.4.)

### 10.3 Reference stability — where this breaks if we are sloppy

`runFor` is a `useSyncExternalStore` selector, and `EMPTY_RUN` is a frozen shared object precisely
because "a fresh object [per snapshot] and React's `useSyncExternalStore` loops"
(`swarmStore.ts:93-99`).

- `SwarmRun.feed` defaults to a module-level frozen `EMPTY_FEED: readonly FeedEvent[] =
  Object.freeze([])`, and `EMPTY_RUN` must carry that exact reference.
- **The feed array gets a new identity only when events actually append.** On both paths: filter
  incoming to `seq > currentMaxSeq`; **if the filtered set is empty, return the previous array
  reference unchanged.** This one line is what stops the 60s stalled-watcher re-projection from
  re-rendering the feed forever.
- Cap the renderer array at `MAX_FEED = 500` with `.slice(-(MAX-1))` (`swarmStore.ts:78` precedent);
  the truncation row is prepended at render, not stored.
- Selector shape: `useSwarmStore(s => s.runs.get(boardId)?.feed ?? EMPTY_FEED)` — an array reference,
  not a derived object. All grouping/collapsing/filtering happens in a `useMemo` keyed on
  `[feed, filter, collapseRepeats]` inside the feed component.
- **`SwarmBoard.tsx:137-138` already subscribes to the whole `boards` array**, so the board
  re-renders on every canvas drag frame of any board. The feed must therefore be its own
  `React.memo` component taking only `(feed, workers, filter)`. Skip this and dragging the board
  re-renders 200 rows per frame. **This is the likeliest perf regression in the feature.**

---

## 11. Persistence stance

**Hard rules honoured:** `SWARM_LEDGER_VERSION` stays **1**. All new kinds ride the open-vocabulary
`coerceEvent` path. **No new top-level `SwarmRunLedger` key** — anything the feed needs is an *event*
or a field on an existing per-event object. That constraint is why `truncated` is an event rather
than a header field.

| class | stance | volume | rationale |
|---|---|---|---|
| `workerSpawned` | **durable — must** | ≤8/run | the feed's opening line; today unrecoverable across restart |
| `planTicked` | **durable — must** | 8-20/run | carries the `4/8` progress narrative |
| `truncated` | **durable — must** | ≤1/run | makes overflow honest; must survive the clamp itself |
| `refused` | **durable — should** | 0-3/run | the record of a thing that didn't happen is unreconstructable |
| `gateDecision` | **durable — should, as a POINTER** | 1-10/run | see below |
| `humanAction` | durable — nice | 1-5/run | first to cut |
| `delta` (per token) | **ephemeral forever** | 1000s | — |
| tool lifecycle | **ephemeral forever** | 2 × tools × N workers | *"High-frequency N-worker status must NEVER be a durable content write"* (`commandFeedTypes.ts:11-16`). Feeds the rail HUD + collapsed ticker only; the `denied` phase graduates as `gateDecision` |
| gap rows, closing summary, `×N`, truncation copy | **derived at render** | — | never stored |
| filter / pinned / timestamp mode / expanded row / `backFace` | **never persisted** | — | scene/session split: ephemeral session state never routes into a patch key |
| `dockLayout.feed` | **persisted** | — | a layout size like `chat`/`rail`/`triage`; optional + default-at-read ⇒ no schema bump |

**`gateDecision` is a pointer, not a copy.** The authoritative record already exists in
`mcp-audit.jsonl` (append-only, rotated at 8 MiB, `auditLog.ts:39`). Do **not** fork a security
artifact into a store that is pruned at 20 runs/project and clamped at 500 events. The ledger event
carries `{decision, tool, targetWorkerId, auditSeq}` — a narration pointer. Requires threading
`runId` into the gate (§12.3).

**`workerSpawned` should carry the model tier.** MAIN knows it at spawn time — `composeRoleLaunch`
literally composes `claude --model <tier>` (`swarmTools.ts:410-417`). Shape:
`{workerId, role, title, agentKind?, modelTier?}`. It is a *new kind*, not a new top-level key, so
this is free — and it makes provider durable at the one place it matters, removing renderer-side
derivation for historical rows whose board may no longer exist.

---

## 12. Wireframes

### 12.1 Resting / compact — the real post-#416 board, 1180 × 660

```
┌─ BoardFrame titlebar ─────────────────────────────────────────────────────────────────────── 34px ─┐
│ Swarm · ship the mission feed                                                        ⟳  ⤢  ⋯      │
├────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ .sw-head   flex:none  ~65px                                                                        │
│  ⏱ 12:41   [auto-approve reads]  [ask on write]                             [ Pause all ]     24px │
│  .sw-plan  ▸1 ledger kinds ▸2 wire ▸3 store ▸4 rows ▸5 filters ▸6 …    overflow-x:auto      ~37px  │
├──────────────────────────────────┬────┬────────────────────────────────────────────────────────────┤
│ .sw-chat   300px   grid-row 1/4  │6px │ .sw-canvas   874 × 359   (row 1, the only 1fr)             │
│ ┌ transcript ── 300 × 335 ─────┐ │Dock│ ┌ .sw-rail 208 ──┐┌ .sw-vp 666px  ELASTIC — UNCHANGED ──┐ │
│ │  …orchestrator turn text…    │ │Div │ │ ● Builder-1    ││ ┌ Builder-1 · BUILDER · SONNET · write┐│
│ │                              │ │ x  │ │   BUILDER·SONNET││ │                                   ││
│ │  I'll dispatch T-04 to       │ │    │ │   T-04    4m12s ││ │     docked xterm  (untouched)     ││
│ │  Builder-1 and have          │ │    │ ├────────────────┤│ └───────────────────────────────────┘│
│ │  Explorer-2 map the …        │ │    │ │ ! Explorer-2   ││ ┌ Explorer-2 · EXPLORER · HAIKU · ro ┐│
│ └──────────────────────────────┘ │    │ │   EXPLORER·HAIKU││ │     docked xterm  (untouched)     ││
│ ══ NEW DockDivider axis="y" ══ 6 │    │ │   stalled  6m   ││ └───────────────────────────────────┘│
│ ┌ .sw-feed ─── 300 × 220 ──────┐ │    │ ├────────────────┤│                                       │
│ │● Live  Milestones▾  ⌕  4/8 ⏱│ │ 24 │ │ ● Reviewer-3   ││                                       │
│ ├──────────────────────────────┤ │    │ │   REVIEWER·OPUS ││                                      │
│ │ All   B1   E2   R3           │ │ 20 │ └────────────────┘└───────────────────────────────────────┘
│ ├──────────────────────────────┤ │    ├──────────────── 6px DockDivider axis="y" ───────────────────┤
│ │ 00:04 + Builder-1 spawned    │ │ 22 │ .sw-needs   874 × 196   (row 3, auto)                       │
│ │ 00:31 → T-04 → Builder-1     │ │ 22 │  ! Explorer-2 stalled 6m   [Nudge] [Salvage] [Dismiss]      │
│ │ 02:10 ⚑ you approved pty.ts  │ │ 22 │  ⚑ Builder-1 wants: edit src/main/pty.ts   [Allow] [Deny]   │
│ │ 07:40 ! Explorer-2 stalled ×4│ │ 22 │                                                             │
│ │ 08:02 ↺ Explorer-2 salvaged  │ │ 22 │                                                             │
│ │ 09:15 ✓ Builder-1 reported   │ │ 22 │                                                             │
│ ├──────────────────────────────┤ │    │                                                             │
│ │ ↓ 3 new events               │ │ 20 │  ← jump bar: sibling of the scroller, only while detached   │
│ └──────────────────────────────┘ │    │                                                             │
└──────────────────────────────────┴────┴─────────────────────────────────────────────────────────────┘
  chat 335 + 6 + feed 220 = 561      │   .sw-canvas 359 + 6 + triage 196 = 561   ← terminals lose 0px
```

Collapsed (`dockLayout.feed = 24`, snapped from a drag under 96px):

```
│ ┌ .sw-feed ─── 300 × 24 ───────┐ │
│ │● 09:15 ✓ Builder-1 reported ⌃│ │   ← header becomes the ticker; chat gets 531px back
│ └──────────────────────────────┘ │
```

### 12.2 Expanded / full — flip back face, `backFace = 'feed'`

```
┌─ BoardFrame titlebar ─────────────────────────────────────────────────────────────────────── 34px ─┐
│ Swarm · ship the mission feed                                                        ⟳  ⤢  ⋯      │
├──────────────────────────────────────────────────────────────────────── face header ──────── 32px ─┤
│ [ Plan ] [·Feed·]  ● Live  Everything ▾  ☑ Collapse repeats  ⌕ search…   4/8 · 12:41       [ ↩ ]   │
├────────────────────────────────────────────────────────────── scroller, 1180 × 594 ────────────────┤
│ 12│2│ 46 │8│10│8│    96   │8│    96    │8│          ~640 1fr           │8│ 64 │8│ 56 │8│32│12      │
│                                                                                                    │
│  ⋯      —   —          TRUNCATED   1,204 earlier events dropped — capped at 500 (through 03:12)    │
│  00:00  +   —          STARTED     Run started — ship the mission feed                   —      —  │
│  00:04  +   Builder-1  SPAWNED     builder · sonnet · .worktrees/feat-feed              0.9s    —  │
│              BUILDER                                                                               │
│  00:05  +   Explorer-2 SPAWNED     explorer · haiku · .worktrees/feat-feed              0.8s    —  │
│              EXPLORER                                                                              │
│  00:31  →   Builder-1  DISPATCHED  T-04 wire the ledger event kinds              T-04    —      —  │
│  02:10  ⚑   you        APPROVED    Builder-1 → edit src/main/swarmLedger.ts       —      —      —  │
│ ▏07:40  !   Explorer-2 STALLED     no output for 6m                              T-07    6m    ×4  │
│ ▏08:02  ↺   Explorer-2 SALVAGED    T-07 requeued · worktree kept                  T-07    —     —  │
│  09:15  ✓   Builder-1  REPORTED    5 kinds added; coerceEvent unchanged           T-04  8m44s   —  │
│   ┌ expanded — max 88px, one at a time ────────────────────────────────────────────────────────┐   │
│   │ Added workerSpawned, planTicked, refused, gateDecision, truncated. No version bump —        │   │
│   │ coerceEvent is already open-vocabulary. Clamp now preserves the marker at index 0.          │   │
│   │ src/shared/swarmLedgerTypes.ts · src/main/swarmLedger.ts · 2 tests added.                   │   │
│   └────────────────────────────────────────────────────────────────────────────────────────────┘   │
│  ────────────────────── session restored · 3 workers rehydrated ─────────────────────────── 22px   │
│                              — 4m quiet —                                                   22px   │
│  12:41  ✓   —          COMPLETE    8/8 plan items · 5 workers · 2 stalls · 1 salvage      —     —  │
├────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ↓ 3 new events                                                                              20px   │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
  ▏ = 2px --err/--warn left bar (severity: problem). The front face .sw-root stays MOUNTED behind
    (pointerEvents:'none' + isolation:'isolate') — no docked PTY tears down.
```

### 12.3 The sample run as compact copy (300px, Milestones ON)

```
00:00 + Run started
00:04 + Builder-1 spawned          ← needs NEW ledger kind workerSpawned
00:31 → T-04 → Builder-1
02:10 ⚑ you approved pty.ts        ← needs NEW gateDecision (runId threading)
05:03 · Builder-1 working          ← chatter; hidden unless Everything
07:40 ! Explorer-2 stalled     ×4  ← ×4 collapses the 60s watcher repeats
08:02 ↺ Explorer-2 salvaged
09:15 ✓ Builder-1 reported
10:58 ✓ Plan 6/8 · wire the store  ← needs NEW planTicked
12:41 ✓ Run complete               ← derived, not an event
```

---

## 13. Worker pills (the secondary steal)

### 13.1 Rail card (208px) — role and provider get their own line

```
 ┌ 208px ───────────────────────┐
 │ ● Builder-1                  │  line 1 · 18px · 8px .sw-st dot + name; name takes ALL leftover
 │   BUILDER · SONNET           │  line 2 · 16px · two .sw-role--bare pills, 9px mono, --text-3
 │   T-04 wire the ledger  4m12s│  line 3 · 16px · live HUD (ephemeral tool phase) + elapsed
 └──────────────────────────────┘  ≈54px card
```

This dissolves the 76px-cap tension entirely. `swarm.css:685-687` documents that the **name
deliberately wins leftover width** — so put nothing else on line 1. Line 2 has 208 − 16 padding =
192px for `BUILDER` (~48px) + `·` + `SONNET` (~44px) ≈ 100px — comfortable, with room for
`INTEGRATOR · HAIKU`.

Use **`.sw-role--bare`** (identical font/size/colour/`max-width:76px`; **no border, no
`padding: 0 5px`**) with a literal `·` separator. Two bordered pills side by side at 9px reads as
chrome. `.sw-role` itself is unchanged ⇒ nothing else regresses.

### 13.2 Provider derivation (renderer-side)

Reuse the expression that already exists at `SwarmDock.tsx:149-151` —
`presetById(board.agentKind)?.label ?? agentIdentity(board.launchCommand, board.shell)` — which today
only feeds an idle affordance. Lift it into one helper, use it in **three** places: rail line 2, dock
pane head, and the feed's `SPAWNED` row. Note `SwarmWorkerCards`' props today are
`{run, attention, running, now, titleOf, onOpen, dockedIds, activeDockId, width}` — no board objects
— so the rail needs a new prop or a `useCanvasStore` lookup.

**Ladder, most-discriminating first:**

1. **Model tier** parsed from `launchCommand` (`--model sonnet` → `SONNET`). This is the right
   default: when all five workers are Claude (the common case) the *family* discriminates nothing
   and the tier discriminates everything.
2. **Provider family** from `agentKind` (`CLAUDE`, `CODEX`, `GEMINI`) when no tier is parseable.
3. **Nothing** if neither. Never render a raw command fragment in a 9px pill.

**Better: make it durable** — put `agentKind` + `modelTier` on the new `workerSpawned` event (§11).

### 13.3 Dock pane head (32px, `SwarmDock.tsx:166-172`)

Today `role · read-only|write`. Extend to:

```
 Builder-1 · BUILDER · SONNET · write
 ↑ name      ↑ role    ↑ tier   ↑ posture, right-aligned
```

Posture sits last but is the only element that gets **colour**: `write` renders with a `--warn`
border (not fill), `read-only` (`RolePack.permissionMode: 'plan'`) renders plain `--text-3`. Colour
goes to the risky state, which keeps colour functional per the design rule.

---

## 14. Implementation plan

**Blocked.** Nothing below starts until #12 and #14 merge. Slice S5 is the one exception (see the
conflict matrix).

### 14.1 Conflict matrix (from the sibling-worktree recon)

| surface | vs #12 `plan-strip-kanban` | vs #14 `swarm-prompt-overhaul` |
|---|---|---|
| `swarmTools.ts` event taps | **none** — #12 doesn't touch it | **low** — #14 edits only `buildSwarmToolDefs` (`:267`, `:323`, +4 lines); taps go in `executeSwarmTool` (`:433+`). Disjoint ⇒ clean auto-merge, re-anchor line numbers only |
| `swarmLedgerTypes.ts` additive field | **direct collision** — #12 inserts `planHolders?` at `:339-344`, between `planOwners` and `workers`, in the same `SwarmLedgerSnapshot` struct. Also adds a sibling line in `buildSnapshot`'s object literal (`swarmLedgerProject.ts:587`) | none |
| swarm board layout / faces | **hard collision** — #12 rewrites ~388 lines of `SwarmBoard.tsx` (the entire JSX tree re-indents two levels into the flip stage) and owns the flip + `SwarmPlanStrip`'s new `onFlip?` prop | none — #14 touches no swarm renderer file |
| `swarm.css` | **collision, trivial class** — #12 appends 330 lines at EOF (1047 → 1379). Append-only usually auto-merges; do **not** reuse `.sw-kb-*`, those are taken | none |

**#12 and #14 share zero files** except `package.json` (both bump the version: #12 → 0.45.1,
#14 → 0.46.0). **Rebase order: #12 first** (it owns 4 of our 4 collision surfaces), then #14, then
us. Expect a 1-line `package.json` conflict on every rebase, and recompute our own bump off the tip
we land on.

Also note: `swarmChatIpc.ts:386-416` is #14's new roster-injection block — if a later slice taps the
per-turn path there, that is the collision zone.

### 14.2 Slices

| slice | scope | files | bump | rebase |
|---|---|---|---|---|
| **S0** *(this PR)* | the report | `docs/research/2026-07-31-swarm-mission-feed/report.md` | none (docs-only) | — |
| **S1 — MAIN: durable kinds + taps** | `workerSpawned`, `planTicked`, `truncated` kinds; append taps at `swarmTools.ts:620` (spawn) and `:824` (`tick_plan_item`); clamp rewritten to preserve the marker in **both** call sites; unit tests incl. a round-trip through `coerceEvent` | `swarmLedgerTypes.ts` · `swarmLedger.ts` (+test) · `swarmTools.ts` | patch | **#12** (types struct), **#14** (line shift) |
| **S2 — wire: backfill + incremental** | `events?` + `eventHead?` on `SwarmLedgerSnapshot`; new `swarm:runEvent` `kind:'feed'`; preload mirror + **kind-set lockstep test**; `useSwarmEvents` branch; `swarmStore.feed` + frozen `EMPTY_FEED` + the return-previous-reference rule. No UI — asserted by unit test | `swarmRunEvent.ts` · `swarmChatIpc.ts` · `preload/swarm.ts` · `swarmLedgerProject.ts` · `useSwarmEvents.ts` · `swarmStore.ts` | patch | **#12** (same struct + `buildSnapshot` literal) |
| **S3 — renderer: compact feed pane** | `.sw-feed` region in `.sw-chat`; `dockLayout.feed` + clamp + **add `'feed'` to `swarmBoardSchema.ts:18`'s literal list**; `SwarmFeed.tsx` (`React.memo`); rows, Milestones filter, repeat-collapse `useMemo`, live-follow + jump bar; `swarm.css` append | `SwarmBoard.tsx` · `swarm/SwarmFeed.tsx` (new, +test) · `useDockLayout.ts` · `swarmBoardSchema.ts` · `boardSchema.ts` · `swarm.css` | **minor** (new subsystem) | **#12 HARD** |
| **S4 — the full-view flip face** | `backFace: 'kanban' \| 'feed'` session state inside #12's `{flip.flipped && …}` block; `[ Plan ] [ Feed ]` face-header tabs; full row layout, search, facets, `.sw-role--bare` | `SwarmBoard.tsx` · `SwarmFeedFace.tsx` (new, +test) · `SwarmPlanStrip.tsx` · `swarm.css` | patch | **#12 HARD — strictly after S3** |
| **S5 — worker pills** *(parallelisable)* | 3-line rail card, `.sw-role--bare`, provider helper lifted from `SwarmDock.tsx:149-151`, dock pane head | `SwarmWorkerCards.tsx` (+test) · `SwarmDock.tsx` · `swarm.css` | patch | **neither lane touches these files** — can land before or independent of S3/S4 |
| **S6 — deferred** | `refused`, `humanAction`, `gateDecision` (needs `runId` threaded into `dispatchGate.ts:201-205` — a security-sensitive path); "Copy feed as markdown" (a run narrative is the thing people paste into a PR description) | — | — | after S4 |

**Design-artifact gate:** S3 and S4 are UI, so per *Design artifact before code* they need a
rendered mock signed off before implementation. §12's wireframes are the structural artifact; a
throwaway HTML mock using the real tokens from `index.css` should precede S3. Note the sibling lane
left an untracked Playwright probe (`plan-strip-kanban/e2e/planKanbanProbe.e2e.ts`) that is a usable
template for flip screenshots.

---

## 15. Open questions for the user

1. **Is the orchestrator transcript's 561px height sacred?** The recommended placement costs it
   226px (561 → 335). If the mental model is "the chat *is* the swarm", this is the contentious
   call. The fallback (28px `.sw-body` row) is available but bills PR #416's terminals 34px.
   **This is the one decision I would not make alone.**
2. **Do older builds tolerate an unknown ledger `kind`?** `coerceEvent`'s forward-safety is proven
   at the *read* layer; the *renderer* consuming the projection is not audited. If anything
   switch-exhausts or renders `undefined`, six new kinds is six ways to break a released build
   opening a dev-written project. **Verify in S1 before shipping any new kind** — it is the only
   thing that could invalidate the no-version-bump conclusion.
3. **`gateDecision` scope.** Threading `runId` into `dispatchGate.ts:201-205` touches a
   security-sensitive path. In S1, or deferred to S6? If deferred, the feed ships without gate rows
   and the "gate" beat degrades to the triage block only — acceptable, but a visible hole in the
   very narrative that motivated the feature.
4. **Cursor vs wholesale backfill** (§10.2). The per-`(webContents, boardId)` `sinceSeq` cursor is
   new statefulness on a push channel; the stateless fallback re-sends ~60-100 KB whenever
   `eventHead` changes. Pick deliberately.
5. **`backFace` persistence.** Recommended session-only Zustand (no schema bump at all). Persisting
   it as `SwarmBoard.backFace?` is additive-optional (writer-only bump per ADR 0007) but costs a
   migration slot for a preference that is cheap to lose on reload.
6. **`humanAction` voice.** Rows read `you dismissed Explorer-2's stall` — the first ledger event
   whose actor is the human, not an agent. `you` vs `human` vs the OS username. I would use `you`.

**Resolved during synthesis, recorded so nobody re-asks:**

- *Does the 60s watcher flood the ledger?* **No** — one `stall` event per episode, guarded at
  `swarmWatch.ts:381-384`; the 60s cadence is a snapshot *re-push*, not an append.
- *Does a swarm flip exist on `main` today?* **No.** `SwarmPlanStrip` on `main` is the header chip
  strip, not a face; `SwarmPlanKanban` does not exist on `main`; `feat/plan-strip-kanban` had zero
  commits at recon time (its work is **staged in the index** — inspect with `git diff HEAD`, not
  `git diff`). `useTerminalFlip` is a shared boolean-only hook with 3 consumers.
- *Does #14 change any shape a feed row displays?* **No.** `dispatch_task` field names, `list_workers`
  output, and every ledger/snapshot type are unchanged; only descriptions were enriched. The one
  consequence is the 5th role, `researcher`.

---

## 16. Appendix — file index

| area | file |
|---|---|
| ledger types + caps + versions | `src/shared/swarmLedgerTypes.ts` |
| ledger store, append/clamp/persist | `src/main/swarmLedger.ts` |
| ledger session mutations | `src/main/swarmLedgerSession.ts` |
| snapshot projection | `src/main/swarmLedgerProject.ts` |
| stall/death/restore watcher | `src/main/swarmWatch.ts` |
| swarm tool executor (spawn/dispatch/tick) | `src/main/swarmTools.ts` |
| turn loop, IPC push, ledger push | `src/main/swarmChatIpc.ts` |
| wire event union | `src/main/swarmRunEvent.ts` |
| dispatch gate + audit | `src/main/dispatchGate.ts` · `src/main/auditLog.ts` |
| run-file IO | `src/main/canvasMemory.ts` |
| preload mirror | `src/preload/swarm.ts` |
| renderer subscription | `src/renderer/src/store/useSwarmEvents.ts` |
| renderer store | `src/renderer/src/store/swarmStore.ts` |
| board host | `src/renderer/src/canvas/boards/SwarmBoard.tsx` |
| swarm sub-components | `src/renderer/src/canvas/boards/swarm/` |
| flip hook | `src/renderer/src/canvas/boards/useTerminalFlip.ts` |
| timeline precedent | `src/renderer/src/canvas/boards/command/CommandRecapView.tsx` |
| virtualization | `src/renderer/src/lib/virtualizer.ts` · `canvas/boards/osr/virtualRows.ts` |
| styles | `src/renderer/src/styles/boards/swarm.css` |
