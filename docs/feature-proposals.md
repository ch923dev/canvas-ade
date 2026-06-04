# Canvas ADE — Feature Proposals (research-backed)

> **Status:** proposals only — nothing here is committed to the roadmap or built. Source: web
> research (6-agent workflow, 2026-05-30) cross-referenced against the codebase + `docs/roadmap.md`.
> Competitor field surveyed: Conductor, Crystal, Warp, Cursor, Claude Squad, Sculptor, Maestri,
> Vibe Kanban, Terragon, iTerm2/NTM.
>
> **How to use this doc at ship time:** when a feature reaches the build queue, open its entry and
> run its **Viability checklist**. Each checklist re-validates the assumptions this proposal was
> written on (dependencies landed? stack constraints still hold? acceptance criteria definable?).
> If a checklist item fails, the feature is NOT viable yet — note why and defer. Update the
> **Status** line of the entry as it moves: `proposed → accepted → in-progress → shipped → dropped`.

> ⚠️ **Re-scoped 2026-05-30 — git worktrees deferred; the "Phase 3 unlock gate" assumption below is
> stale.** Phase 3 ships persistence + board actions + **port detect → push to preview** (Slice C′),
> NOT git worktrees. Worktrees moved to a **post-MCP phase** under a better model — **Feature
> Workspaces** (FW-1 below): a worktree backs a *feature zone* (a cluster of boards), **not a single
> board**. So every entry that says "per-board worktree" (SB-3 fan-out, SB-5 diff panel, OS-1
> commit/merge/PR) now depends on **FW-1 / the Feature Workspaces phase**, and should be read against
> the per-zone model — not Phase 3. Per-board *ports* are likewise re-scoped to runtime detection
> (Slice C′), not static assignment. Don't promote a worktree-dependent entry until FW-1 lands.

---

## Why these features (positioning)

The competitive field converges on **four pillars** for AI-assisted dev tooling:

1. **Status / attention visibility** — which agent needs me right now.
2. **Diff-first review** — review bandwidth (not compute) is the bottleneck (~96% of devs don't
   fully trust AI-generated code).
3. **Parallel / best-of-N execution** — run several attempts, keep the best.
4. **On-surface git integration** — commit/merge/PR without leaving the tool.

Canvas ADE's differentiator: it can do all four **spatially** — status as a glanceable map, diffs
scoped to the board that owns the worktree, fan-out laid out side-by-side, and a persistent
ownership graph (connectors) that no list/kanban tool can express. The **signature bets** lean into
that spatial + multi-agent edge; the **quick wins** are table-stakes parity that the locked stack
makes nearly free.

---

## Dependency graph (read before sequencing)

```
status-detection ─────► prompt-queue (auto-advance) ─────► Run-on-Agent
                  └────► attention queue + notifications

FW-1 / Feature Workspaces (post-MCP) ─► diff panel ─► fan-out ─► commit/merge/PR
                                      └► broadcast-input (complements fan-out)

persistence (Phase 3: canvas.json + schemaVersion)
   ├─► board-to-board connectors
   ├─► saved camera views ("Spots")
   ├─► screenshot-to-assets
   └─► Run-on-Agent binding (itemId → terminalBoardId)

zero-dependency (ship anytime):
   ├─► terminal scrollback search
   └─► browser console capture
```

**Key takeaway:** **Persistence (Phase 3, shipped) + FW-1 / Feature Workspaces (post-MCP) are the
unlock gates.** Persistence already landed; FW-1 gates the worktree-dependent features. Two features
(scrollback search, console capture) have **no dependency** and can ship immediately.

---

## Legend

- **Effort:** `low` (hours–1 day, no new process/native work) · `medium` (multi-day, touches
  MAIN + renderer + state) · `high` (not shortlisted — see Dropped).
- **Tier:** ⭐ signature bet · ✅ quick win · ◆ other shortlisted.
- **Status:** `proposed` until a build session promotes it.

---

# Foundational phase (deferred)

## FW-1 · Feature Workspaces — worktree-backed board zones ⭐

- **Status:** deferred (post-MCP phase; decided 2026-05-30)
- **Effort:** high (new spatial-grouping concept + git worktree lifecycle + MCP orchestration)
- **Roadmap slot:** post-Phase 3, gated on the `canvas-ade-mcp` swarm layer. This is the deferred,
  re-modelled home for git worktrees (originally mis-scoped as "per-board" in Phase 3 Slice C).
- **Depends on:** `canvas-ade-mcp` swarm layer; `simple-git` in MAIN (locked); persistence (Slice A,
  done) for zone↔branch state; board grouping primitive.

### What it does
A project's infinite canvas hosts multiple **feature zones** — clusters of boards that belong to one
feature. Example: an **Auth/Login** zone = a Terminal (agent building auth) + a Browser (previewing
the login page) + a Planning board (auth checklist); a separate **Signup/Landing** zone has its own
three. **Each zone is backed by one git worktree + branch.** Every board in a zone operates against
that branch's checkout — the agent edits files there, the browser previews that worktree's dev server
(its detected port, Slice C′), the plan tracks that feature. The canvas literally lays out parallel
features as spatial neighbourhoods, each on its own branch.

### Why valuable
This is the model the original per-board worktree design lacked. Devs think in **features/branches**,
not in per-terminal checkouts — a zone maps a region of the canvas to a branch, which is how parallel
work is actually organised. It is the natural substrate the MCP swarm layer orchestrates over
(spin/assign/merge agents per zone), and it makes the spatial canvas uniquely expressive for
multi-feature parallel development. Subsumes the worktree dependency of SB-3 / SB-5 / OS-1.

### Implementation sketch (high level — needs its own brainstorm + spec when the MCP lands)
- **Zone primitive:** a persisted grouping of board ids + a bound branch/worktree. (Note: a *visual*
  frame can't clip a live Browser native view — ADR 0002 / the dropped "Frames" idea — so a zone is a
  data grouping + light affordance, not a clipping container.)
- **Worktree lifecycle in MAIN** (`simple-git`): create worktree+branch on zone create; the still-
  valid locked rules apply — reuse-if-exists, never nest-init, keep-on-disk + prompt on dirty delete,
  `git worktree remove` never `rm -rf`, frame-guarded IPC.
- **Worktree location** (open): NOT inside the project working tree (user constraint 2026-05-30) — a
  sibling dir or userData, decided at spec time.
- **Boards inherit the zone's checkout:** a Terminal's `cwd` = the zone worktree path (the existing
  spawn plumbing already threads `cwd`); the Browser previews that worktree's dev server.
- **MCP orchestration:** the swarm layer assigns/runs agents per zone, merges/cleans branches.

### Viability checklist (run at ship time)
- [ ] `canvas-ade-mcp` swarm layer exists and can own multi-agent orchestration.
- [ ] Zone grouping primitive persists + round-trips (schema bump + migration).
- [ ] Worktree add/remove works on Windows under a spaced path; dirty-delete prompt fires.
- [ ] Worktree files live OUTSIDE the project working tree (user constraint).
- [ ] `simple-git` in MAIN only, frame-guarded; no Browser→PTY path introduced.
- **Acceptance:** create two zones on one canvas → each gets its own branch+worktree; the agents in
  each zone edit isolated files; previews + plans scope to their zone; deleting a zone prompts on a
  dirty worktree and removes it via `git worktree remove`.

---

## SA-1 · AI semantic arrange — smart auto-tidy ◆

- **Status:** deferred (post-MCP phase)
- **Effort:** medium (layout heuristics + an MCP tool surface; no native/process work)
- **Roadmap slot:** post-MCP, gated on the `canvas-ade-mcp` swarm layer.
- **Depends on:** `canvas-ade-mcp` (a tool the agent can call to read board metadata + write
  positions); the **shipped deterministic tidy** it upgrades.

### Shipped baseline (this is the thing it upgrades)
A **FancyZones-style preset picker** already ships: the camera-cluster **Tidy** button opens a grid
of layout thumbnails (`lib/layoutPresets.ts`); the `t` key applies Smart. Each preset arranges the
boards then fits the camera (`auto-fit`). Two paradigms:
- **Smart (link-aware, default)** — reposition-only, keeps board sizes. Reads the `previewSourceId`
  graph (`lib/tidyLayout.ts`): each Browser preview groups with the Terminal that drives it; the
  source terminal lands centered under its row of previews; standalone terminals flank it. (`by-type`
  and naive `grid` modes also exist in tidyLayout but aren't surfaced in the picker.)
- **Tiling templates** — window-manager RESIZE-to-fill (`lib/tileLayout.ts`): `2/3/4 columns`,
  `main + sidebar` (largest board = main), `grid` (adaptive). Carve a pane-aspect block into zones
  and resize every board to fill its zone edge-to-edge, then fit → fills the screen like FancyZones.
  (Decision recorded 2026-06-01: user wanted these specifically over the text menu.)

**Bake-off evidence (2026-06-01, judged on a real 6-board canvas):** link-aware **smart** scored
12/20 and *beat* a free-form LLM arrange (11/20) — and the LLM mis-reported its own layout (claimed a
terminal centered under a trio; it was 506px off). Conclusion: when the link graph exists, a
deterministic preset gives AI-quality grouping with **zero cost, full determinism, and no
hallucination**. AI is reserved for canvases the graph can't describe (below).

### What AI adds
A **semantic** arrange mode that groups boards by relationship instead of raw position:
- keep a Browser next to the **Terminal that drives it** (the `previewSourceId` link / connector
  arrow) so a preview never drifts away from its server;
- cluster the boards of one **feature zone** (FW-1) together, zones laid out as neighbourhoods;
- read a Planning board's checklist / a terminal's task to infer intent and place related work
  adjacently ("these three boards are all the auth feature → pack them as a group").

The geometric packer stays the default (fast, offline, deterministic); semantic arrange is an opt-in
"Arrange by feature" that calls the model.

### Implementation sketch (needs its own brainstorm + spec when the MCP lands)
- **MCP tool:** `arrange_canvas` — input: board summaries (id, type, title, size, `previewSourceId`,
  zone, checklist titles); output: an ordered grouping. The model only decides *grouping + order*; the
  existing `tidyLayout` shelf-packer turns each group into non-overlapping coordinates (so the AI never
  emits raw geometry → no overlap/NaN risk, stays deterministic per group).
- **Reuse:** feed the AI's group order into `tidyLayout` per cluster, then place clusters as blocks —
  one tracked undo step via the same `tidyBoards` store path.
- **Guardrails:** a pure post-pass asserts no overlaps and clamps to the canvas; if the model is
  unavailable, silently fall back to geometric tidy (no hard dependency on a live model).

### Viability checklist (run at ship time)
- [ ] `canvas-ade-mcp` exists and can expose a read-boards / write-positions tool to the agent.
- [ ] FW-1 zones (or at least the `previewSourceId` link) provide the relationship signal to group on.
- [ ] AI output is grouping-only; final geometry still flows through `tidyLayout` (no model-emitted
      coordinates) and a no-overlap post-pass.
- [ ] Falls back to geometric tidy when no model is available (feature degrades, never breaks).
- **Acceptance:** a canvas of mixed, scattered boards → "Arrange by feature" packs each terminal with
  its linked browser and each zone's boards as a neighbourhood, no overlaps, one undo step; with the
  model off, the same button still geometric-tidies.

---

# Signature bets

## SB-1 · Board status states + "needs you" attention queue + notifications ⭐

- **Status:** proposed
- **Effort:** medium
- **Roadmap slot:** extends Phase 2.1 Terminal basic-states (`spawning/running/exited`) into rich
  agent states; the attention-queue + notification layer slots alongside Phase 3 Focus/Full view
  (shares the camera-fly API).
- **Depends on:** nothing hard (header glyph already exists). Synergises with prompt-queue (SB-3
  auto-advance) and minimap (QW-2 status-colored dots).

### What it does
Derive each Terminal board's agent state — `working / idle-waiting / awaiting-permission / done /
error` — in MAIN from two sources:
1. **Hook path (precise):** optional Claude Code / Codex hook scripts POST lifecycle events to a
   `localServer.ts` endpoint (e.g. `Stop`, `Notification`, `SubagentStop` hooks).
2. **Heuristic fallback (hookless agents):** PTY-output quiescence timer + a small regex set
   (prompt-return patterns, "Do you want to proceed?" permission prompts, error markers).

State drives three surfaces:
- the existing **header glyph** (commit `344b358` already carries status);
- a docked **attention list** of off-screen boards needing input/done/errored;
- a native **Electron `Notification`** (+ `BrowserWindow.flashFrame`, coalesced) fired only when a
  board changes to idle/needs-input/error **while the window is unfocused**.

Clicking a notification or list item pans/zooms the camera to that board.

### Why valuable
The single most-cited multi-agent pain: you start work in one board, switch away, and an agent
silently waits 20 minutes for input. On an infinite canvas, off-screen boards are literally out of
sight. Glanceable status + a pull-signal queue turns a passive viewport into an orchestration
cockpit — you act only when an agent is blocked or done.

### Implementation sketch
- **MAIN:** state machine per board id; subscribe to the existing PTY data stream + the
  `localServer.ts` hook endpoint. Push state over the existing IPC control plane into the Zustand
  store. Use Electron's built-in `Notification` + `webContents`/`BrowserWindow.flashFrame`.
- **Renderer:** glyph already wired; add the attention-list component to app chrome (outside the
  native-view pane, per ADR 0002); "fly to board" uses React Flow `setCenter`/`fitView`
  (animated `{ duration: 200 }` to match DESIGN.md §9).
- **Heuristic module:** pure, unit-testable (input: PTY chunk + timing → state transition).
- **No new dependencies.**

### Viability checklist (run at ship time)
- [ ] Header glyph status enum still present and the single source of board status (re-check
      `TypeGlyph.tsx` / `BoardFrame` after any chrome refactor since commit `344b358`).
- [ ] `localServer.ts` exists and can accept a local POST without weakening the security model
      (no PTY-write reachable from it; bound to loopback only).
- [ ] Heuristic regex set validated against ≥2 real agents (Claude Code + one other) — measure
      false-idle and missed-idle rates on real sessions.
- [ ] Notifications fire ONLY when unfocused and are coalesced (no storm when N boards finish
      together).
- [ ] "Fly to board" animates (200ms) and the rAF preview-sync follows correctly into the new
      camera position (Browser boards re-attach at destination, no blank snapshot).
- [ ] `awaiting-input` state — confirm whether `pty.ts` now emits it (was forward-wired only per
      `terminalState.ts`); the heuristic must cover it if not.
- **Acceptance:** start a long agent, switch focus away → notification on idle; click it → camera
  flies to that board; attention list reflects all off-screen boards needing action; no false
  notifications during normal streaming output.

---

## SB-2 · Run-on-Agent: dispatch a checklist item to a Terminal board ⭐

- **Status:** proposed
- **Effort:** medium
- **Roadmap slot:** post-Phase 3 (needs persistence for the binding + the prompt-queue feature for
  multi-item sequencing). Natural Phase 3.5 / Phase 4-adjacent capability fusing Planning + Terminal.
- **Depends on:** persistence (binding storage), SB-3 prompt-queue (sequencing), optionally
  SB-4 connectors (visual binding).

### What it does
Each Planning checklist item (and a multi-select) gets a **"Run"** action that writes the item text
as a prompt into a chosen Terminal board's PTY. A target picker binds a checklist (or the board) to
a specific Terminal board. Running streams the item to that board's live agent, the item shows a
**"sent"** state, and multi-item runs enqueue as sequential lines.

### Why valuable
This is what makes a planning board on a canvas worth more than Trello-in-a-tab: plan and executor
share one space, so a checked-off task list becomes agent work without copy-paste. Closes the
checklist→agent loop the research repeatedly points at (spec-kit `tasks.md`, headless `claude -p`,
in-CLI prompt queues).

### Implementation sketch
- A checklist item is just another `pty.write(line + '\r')` to the bound board's MessagePort.
- Add an `itemId → terminalBoardId` binding persisted in `canvas.json` (bump `schemaVersion` +
  migration).
- "Run" control in the existing ChecklistCard chrome; "sent" state in the element data.
- Multi-item → enqueue via the prompt-queue (SB-3).
- Input stays trusted-user-only (security model: Browser content must never reach PTY — checklist
  text is user-authored, so it is allowed).
- **No new process/native dependency.**

### Viability checklist (run at ship time)
- [ ] Phase 3 persistence shipped — `canvas.json` round-trips and `schemaVersion` migration pipeline
      works (the binding must survive reopen).
- [ ] Prompt-queue (SB-3) shipped, or accept single-item-only for v1.
- [ ] Checklist element schema can carry a `sent`/`runState` field and round-trips through
      `toObject`/`fromObject` (Planning `elements` are the most schema-fragile — see roadmap BUG-027).
- [ ] Target picker handles: no Terminal boards exist, target board deleted after binding (dangling
      ref), target board not yet spawned (queue until running).
- [ ] Confirm checklist item text is unambiguously user-trusted (it is) — document that this is the
      one sanctioned path from Planning data → PTY.
- **Acceptance:** bind a checklist to a Terminal board, click Run on an item → text appears as a
  prompt in that terminal; multi-select Run → items sent in order; binding survives app restart.

---

## SB-3 · Fan-out: clone a Terminal board to run the same task N ways ⭐

- **Status:** proposed
- **Effort:** medium
- **Roadmap slot:** Phase 3 — extends the planned Duplicate action; depends on
  git-worktrees-per-board.
- **Depends on:** Duplicate board (Phase 3), per-board worktrees (Phase 3), free-space placement
  (already shipped, commit `170cfc6`). Pairs with diff panel (SB-5) for the compare step.

### What it does
A board action that spawns 2–4 sibling Terminal boards laid out adjacently, each with its own
worktree/branch and the same `launchCommand`, optionally seeded with the same first prompt and
visually grouped. Run multiple agents at one task in parallel, then keep the best worktree and
discard the rest.

### Why valuable
Best-of-N is becoming a standard high-value workflow (Cursor `/best-of-n`, Warp
compare-diffs-across-worktrees). Canvas ADE's spatial layout is uniquely suited: placing N attempts
side-by-side for visual comparison is exactly what a canvas does better than tabs or a kanban column.

### Implementation sketch
- Reuse the planned Duplicate logic × N, each clone gets its own worktree
  (`canvas-ade/<board-id>`) and per-board port.
- Lay out adjacently via the existing free-space placement (`170cfc6`).
- Optional visual group (could ride SB-4 connectors or a frame).
- Seed identical first prompt via the spawn flow's `launchCommand` / first PTY line.

### Viability checklist (run at ship time)
- [ ] FW-1 / Feature Workspaces (post-MCP, deferred) — N isolated worktrees + N branches create cleanly.
- [ ] Runtime port detection (Slice C′, shipped) — N agents each detect their own port; no static
      per-board port assignment (worktrees isolate files, NOT ports — see CLAUDE.md).
- [ ] WebGL budget holds with N more terminals at once (`WEBGL_BUDGET = 8` in `TerminalBoard.tsx`;
      verify the over-budget DOM-fallback path under a 4-way fan-out + existing boards).
- [ ] Process-tree kill works when discarding losing siblings (Windows `taskkill /T /F`).
- [ ] Dirty-worktree-on-delete prompt (locked decision) fires for discarded siblings — never silent
      `--force`.
- **Acceptance:** fan-out a board 3 ways → 3 terminals appear adjacent, each on its own branch, all
      running the same seed; discarding two cleanly removes their worktrees (with prompt if dirty).

---

## SB-4 · Board-to-board connectors (typed edges) ⭐

- **Status:** in-progress (connector model on feat/mcp-integration, lands with PR #32; preview-edge half already on main)
- **Effort:** medium
- **Roadmap slot:** Phase 3 (needs `canvas.json` schema/persistence). Foundational for Run-on-Agent
  bindings and agent→note routing.
- **Depends on:** persistence + `schemaVersion` migration.

### What it does
Draw a labeled bezier edge from one board to another using React Flow's native connection
handles/edges (matching the Planning arrow style). Edges are first-class canvas data
(`{ source, target, label }`) persisted in `canvas.json` and reroute automatically when boards
move. Use to link a Terminal agent to the Browser board previewing its port, or to the Planning
checklist it's working through.

### Why valuable
Devs running parallel agents lose track of which terminal owns which preview/branch/task. Explicit
connectors encode that intent spatially and persistently — the canvas becomes a readable
dependency/ownership graph instead of a pile of cards. This spatial-graph affordance is the core
idea of agent-orchestration canvases (Maestri's pitch) and a unique fit.

### Implementation sketch
- Edges are a core React Flow primitive; boards are already custom RF nodes → add `Handle`s + an
  `edges` array. Auto-reroute on node move is free.
- Reuse the Planning bezier-arrow visual styling.
- Persist edges alongside nodes in `canvas.json` (bump `schemaVersion` + migration).
- Pure renderer/state — no main-process changes.

### Viability checklist (run at ship time)
- [ ] Persistence shipped — edges array round-trips and migrates.
- [ ] Adding `Handle`s to board nodes doesn't interfere with the existing drag/resize/nodrag/nowheel
      interaction zones (esp. Terminal xterm focus and Browser native-view pointer regions).
- [ ] Edges render as HTML/SVG within the canvas — confirm they don't need to overlap a Browser
      native view (which would occlude them, ADR 0002); if they must cross one, accept they pass
      under it or route around.
- [ ] Edge endpoints handle board deletion (dangling edge cleanup).
- **Acceptance:** draw an edge Terminal→Browser, move either board → edge reroutes live; reload app
      → edge persists with its label.

---

## SB-5 · In-board diff review panel (per-worktree changes) ⭐

- **Status:** proposed
- **Effort:** medium
- **Roadmap slot:** Phase 3 (depends on git-worktrees-per-Terminal-board landing); pairs with
  fan-out compare and feeds commit/merge/PR (OS-1).
- **Depends on:** per-board worktrees (Phase 3), `simple-git` in MAIN (locked).

### What it does
A collapsible **"Changes"** panel on each Terminal board showing the live git diff/stat of that
board's worktree vs its base branch: changed-files list, +/- counts, expandable unified hunks,
staged/unstaged, with copy-path and stage/discard actions. Refreshed on a debounced file-watch. A
board shows an **"unreviewed changes"** badge when the agent has written files since you last looked.

### Why valuable
Reviewing what an agent actually changed is the core loop of parallel-agent work — review bandwidth,
not compute, is the real bottleneck (~96% of devs don't fully trust AI code). A diff-first view
scales review time with change size, not codebase size, and putting it on the board that owns the
worktree means no tab-switch to an external editor. Headline feature across the competitive field
(Conductor, Crystal, Warp).

### Implementation sketch
- **MAIN:** `simple-git` against the board's worktree path → `status` + `diff`; stream over the
  existing IPC control plane. Debounced file-watch (chokidar or `fs.watch`) on the worktree.
- **Renderer:** diff panel in the board content slot (HTML — no native view, no occlusion concern).
- "Unreviewed" badge = compare last-viewed mtime/HEAD vs current.

### Viability checklist (run at ship time)
- [ ] FW-1 / Feature Workspaces (post-MCP, deferred) — each board has a resolvable worktree path on its branch.
- [ ] `simple-git` diff/status performs acceptably on a large repo (debounce + cap hunk size; don't
      block the MAIN event loop — shared with node-pty's IPC fan-out).
- [ ] File-watch doesn't fire a storm during an active agent write burst (debounce verified).
- [ ] Stage/discard actions respect the dirty-worktree safety decision (never destructive without
      confirm).
- [ ] Panel layout coexists with the xterm well (collapsible; doesn't steal terminal height/focus).
- **Acceptance:** agent edits files in its worktree → "unreviewed" badge appears; open panel →
      correct file list + hunks vs base; expanding a hunk matches `git diff`; discard reverts one file.

---

# Quick wins

## QW-1 · Prompt queue + history per Terminal board ✅

- **Status:** proposed
- **Effort:** low
- **Roadmap slot:** Phase 2.1 already specs a "follow-up prompt" control — this extends it into a
  queue + history. Auto-advance depends on SB-1 status-detection.
- **Depends on:** persistence (to persist queue/history) — but a session-only v1 needs nothing.

### What it does
A small composer on each Terminal board to type/queue follow-up prompts written to the PTY in
sequence — the next prompt auto-sends when the agent returns to idle — plus a recallable history of
prompts sent to that board for one-click reuse. Queue + history persist per board in `canvas.json`.

### Why valuable
Devs want to line up the next instruction without babysitting the exact finish moment, and they
constantly re-issue similar prompts. A queue lets you stack work and walk away; history makes
iterative prompting fast. Auto-advancing on the idle transition is the "stop babysitting" pattern.

### Implementation sketch
- Pure renderer UI in the board content slot writing to the existing `pty.write` channel over the
  MessagePort.
- Auto-advance subscribes to the SB-1 idle transition (without it, queue is manual-send-only).
- Persistence rides the planned `canvas.json` autosave (or session-only for v1).
- **No new dependencies.**

### Viability checklist (run at ship time)
- [ ] `pty.write` path over MessagePort still the input channel (re-check after any bridge refactor).
- [ ] Auto-advance: SB-1 idle detection reliable enough to not fire mid-output (or ship manual-only).
- [ ] Queue/history round-trips through schema if persisted (else explicitly session-only).
- [ ] Composer's keydown doesn't collide with the xterm `stopKeys` guard or RF global keys.
- **Acceptance:** queue 3 prompts → each sends when the agent goes idle; recall a past prompt from
      history with one click; (if persisted) queue survives reopen.

---

## QW-2 · Minimap + Cmd/Ctrl+K jump palette ✅

- **Status:** proposed
- **Effort:** low
- **Roadmap slot:** Phase 2.0 app-chrome shell already has a camera cluster + project-switcher
  placeholder — minimap/palette extend that chrome. Ties to SB-1 for status-colored dots.
- **Depends on:** nothing hard (status colors are an enhancement).

### What it does
React Flow's built-in `MiniMap` (boards as dots colored by status/type, draggable viewport rect)
kept in the chrome bar **outside** the native-view pane, plus a **Cmd/Ctrl+K** palette that
fuzzy-searches boards by label/type (and Planning note/checklist text) and pans+zooms to the chosen
board. Palette also exposes canvas actions (add board, zoom-to-fit, reset) and a "next board needing
attention" cycle.

### Why valuable
Past ~6–8 boards spatial memory breaks down and off-screen agents get lost — the practical ceiling
on parallel agents is the human's ability to track them. A minimap gives instant orientation; Cmd+K
is the universal power-user jump devs expect from VS Code / Linear / Raycast (the explicit design
north-star).

### Implementation sketch
- `MiniMap` + `Controls` are drop-in RF v12 components, themed to the blue/dots tokens; `nodeColor`
  callback ties dots to the status enum (SB-1).
- Palette = plain React overlay over the Zustand board list + `setCenter`/`fitView`.
- Kept outside the canvas pane so it never collides with WebContentsView occlusion (ADR 0002).
- **No heavy deps.**

### Viability checklist (run at ship time)
- [ ] `MiniMap` positioned OUTSIDE the native-view pane bounds (else a Browser view paints over it,
      ADR 0002).
- [ ] `nodeColor` maps to the live status enum (or falls back to board-type colors if SB-1 not shipped).
- [ ] Cmd/Ctrl+K doesn't conflict with existing canvas keybindings or xterm focus.
- [ ] Palette fuzzy-search reads Planning note/checklist text from the store without a deep traversal
      perf hit.
- [ ] Camera jump animates (200ms) and preview-sync follows.
- **Acceptance:** minimap shows all boards as status-colored dots; Cmd+K → type a label → camera
      flies to that board; "next attention" cycles through boards needing input.

---

## QW-3 · Terminal scrollback search (Cmd/Ctrl+F) ✅

- **Status:** proposed
- **Effort:** low
- **Roadmap slot:** Phase 2.1 polish or Phase 4 polish — drops in with no dependencies.
- **Depends on:** nothing. **Ship-anytime.**

### What it does
A Cmd/Ctrl+F find bar on each Terminal board that searches the live xterm scrollback with
next/previous navigation, match highlighting, case/regex/whole-word toggles, and an overview-ruler
marker strip — backed by xterm.js's official `@xterm/addon-search`.

### Why valuable
AI agents dump huge volumes of output (file edits, test logs, stack traces). Without search you
can't find the error or the line an agent changed in a long session. Table-stakes in every modern
terminal.

### Implementation sketch
- Load `SearchAddon` alongside the existing fit/webgl addons on the xterm instance in
  `TerminalBoard.tsx`.
- Find-bar UI in board chrome using existing `index.css` tokens.
- **One small official addon dep** (`@xterm/addon-search`).

### Viability checklist (run at ship time)
- [ ] `@xterm/addon-search` version compatible with the pinned `@xterm/xterm ≥5.5`.
- [ ] Find bar keydown stops at the board (xterm `stopKeys` guard) and doesn't trigger RF global keys.
- [ ] Search works on the 5000-line scrollback without lag; overview ruler renders with the WebGL
      renderer active.
- [ ] Addon disposed on board teardown (no leak alongside the WebGL/port teardown).
- **Acceptance:** Cmd/Ctrl+F in a terminal with long output → type a term → highlights + next/prev
      navigate; regex toggle works; closing the bar clears highlights.

---

## QW-4 · Browser board console capture panel ✅

- **Status:** proposed
- **Effort:** low
- **Roadmap slot:** extends Phase 2.2 Browser board (post-Phase 2) — pure additive panel; pairs with
  a future network monitor.
- **Depends on:** nothing. **Ship-anytime.** Notably needs **no CDP** (project deferred CDP attach).

### What it does
A collapsible **"Console"** drawer on each Browser board that streams the previewed page's
`console.log/info/warn/error` (level coloring, filter, clear), with a red badge when the app throws.
Captured in MAIN via the `WebContentsView`'s `console-message` event and pushed to the renderer over
IPC.

### Why valuable
The whole point of a localhost preview board is debugging the running app. Today you'd open external
DevTools; surfacing console errors right on the board closes the build-test loop without leaving the
canvas — and crucially needs NO CDP attach, which the project deferred.

### Implementation sketch
- Hook the existing per-board `WebContentsView` (`partition: preview-<id>`) in `preview.ts` via
  Electron's `webContents` `console-message` event; forward over the established control-plane IPC.
- Renderer panel in the Browser board content slot.
- Stays within `sandbox`/`contextIsolation`.
- **No new deps.**

### Viability checklist (run at ship time)
- [ ] `console-message` event available on the Electron version in use and fires for the previewed
      page's own logs (not Electron internals).
- [ ] Forwarding doesn't add per-frame IPC pressure (it's event-driven, not rAF — confirm it
      doesn't flood during a logging-heavy page; throttle/cap buffer if needed).
- [ ] Panel coexists with the native-view occlusion model — panel is HTML chrome OUTSIDE/below the
      native rect, not under it (ADR 0002).
- [ ] Buffer capped (don't retain unbounded console history → memory leak per board).
- [ ] Security: console capture is read-only; never opens a write path to the page or PTY.
- **Acceptance:** point a Browser board at a localhost app that logs + throws → logs stream into the
      drawer with correct levels; throw shows red badge; clear empties the drawer.

---

## QW-5 · Browser board screenshot capture ✅

- **Status:** proposed
- **Effort:** low
- **Roadmap slot:** Phase 3 (uses `assets/` + atomic-write persistence) — bridges Browser → Planning
  boards.
- **Depends on:** persistence (`assets/` folder) for save-to-disk; clipboard path needs nothing.

### What it does
A camera button on each Browser board that captures the current preview (at its active responsive
preset/zoom) to a PNG, saved into the project's `assets/` folder and/or copied to the clipboard for
pasting into a Planning note or an agent prompt.

### Why valuable
Grabbing a screenshot of the running UI to drop into a bug note, a checklist item, or straight into
the agent's prompt ("fix this layout") is an extremely common loop. Also feeds Canvas ADE's own
Planning boards, tightening the preview→plan→agent cycle inside one app.

### Implementation sketch
- Reuse the `capturePage()` call already in `preview.ts` (used for LOD snapshots).
- Save-to-`assets/` via `write-file-atomic` (assets-by-path is the locked persistence model).
- `clipboard.writeImage` for the clipboard path.
- Trigger button in existing board chrome.
- **No new deps — capture primitive already proven in-repo.**

### Viability checklist (run at ship time)
- [ ] Persistence shipped — `assets/` folder convention exists and atomic-write is wired (for the
      save path; clipboard path can ship earlier).
- [ ] `capturePage()` returns non-blank for the target board — it's blank when detached/occluded, so
      capture **while on-screen and attached** (interacts with LOD detach — capture before detach,
      per ADR 0002 / the Phase 1 finding).
- [ ] Captured at the active responsive preset → correct dimensions.
- [ ] Pasting the clipboard image into a Planning note / agent prompt works end-to-end.
- **Acceptance:** click capture on a connected Browser board → PNG saved to `assets/` AND on
      clipboard; paste into a Planning note shows the shot.

---

## QW-6 · Saved camera views ("Spots") ✅

- **Status:** proposed
- **Effort:** low
- **Roadmap slot:** Phase 3 (persistence) — sits beside Focus/Full view and the minimap/palette
  navigation cluster.
- **Depends on:** persistence (to persist spots); reuses QW-2's camera-jump API.

### What it does
Save the current camera position+zoom as a named **Spot** (e.g. "auth refactor cluster", "preview
wall") and recall it from a list or number keys 1–9 to smoothly animate the camera there. Distinct
from the planned Focus/Full view (which maximizes one board): Spots are reusable bookmarks of
arbitrary canvas regions, persisted in `canvas.json`.

### Why valuable
On a large canvas a dev repeatedly returns to the same few clusters; bookmarked viewports make that
a single keypress instead of pan-hunting, and double as a lightweight project walkthrough. High
value, almost no UI weight.

### Implementation sketch
- A Spot is just `{ name, x, y, zoom }` in `canvas.json`.
- Recall calls React Flow `setViewport({ x, y, zoom }, { duration })`; the rAF preview-sync follows
  automatically.
- Pure renderer + persistence; reuses the Cmd+K jump camera API (QW-2).
- **No new deps.**

### Viability checklist (run at ship time)
- [ ] Persistence shipped — spots array round-trips through schema.
- [ ] Number-key bindings 1–9 don't collide with existing canvas keys (`1`/`0`/Esc are already used
      — pick a non-conflicting modifier, e.g. Shift+1..9, and verify).
- [ ] `setViewport` animation + preview-sync follow correctly (Browser boards re-attach at the
      destination).
- **Acceptance:** save a Spot at a cluster → pan elsewhere → recall → camera animates back to the
      exact saved framing; Spot survives reopen.

---

# Other shortlisted

## OS-1 · One-click commit / merge / open-PR from a Terminal board ◆

- **Status:** proposed
- **Effort:** medium
- **Roadmap slot:** Phase 3 (git-worktree lifecycle) — the integration end of the
  diff/fan-out review chain.
- **Depends on:** per-board worktrees (Phase 3), `simple-git` (locked); aligns with the locked
  "keep on disk + prompt" dirty-worktree decision.

### What it does
Board-level git actions for the board's worktree: commit (message field, optionally
agent-suggested), merge/rebase the board branch back to base with inline conflict flagging, and
"open PR" via `gh` / `git push`. On a clean merge, offers to clean up the worktree (tying into the
planned dirty-worktree prompt).

### Why valuable
After review, integration is where parallel-agent workflows otherwise force a context switch to a
terminal or GitHub. Keeping commit/merge/PR on the board closes the loop end-to-end inside Canvas
ADE — the "no tool-switching" value users praise (Conductor, Claude Squad, Sculptor).

### Implementation sketch
- `simple-git` in MAIN for commit/merge; shell out to `gh` / `git push` over the existing IPC
  control plane.
- Conflict flagging reuses the SB-5 diff data.
- UI in board chrome.

### Viability checklist (run at ship time)
- [ ] FW-1 / Feature Workspaces (post-MCP, deferred) — per-zone worktrees + branches available.
- [ ] `gh` CLI presence detected gracefully (fall back to `git push` + manual PR link if absent).
- [ ] Merge/rebase conflict surfaced safely — never auto-resolve; flag and let the user/agent handle.
- [ ] Clean-merge worktree cleanup goes through `git worktree remove` (never `rm -rf`) and the
      dirty-worktree prompt (locked decision).
- [ ] Long git operations don't block MAIN's event loop (shared with node-pty IPC).
- **Acceptance:** commit a worktree's changes from the board → branch advances; merge to base on a
      clean tree → succeeds + offers cleanup; conflict → flagged, not auto-resolved.

---

## OS-2 · Broadcast input across selected Terminal boards ◆

- **Status:** proposed
- **Effort:** medium
- **Roadmap slot:** post-Phase 2.1 — complements SB-3 fan-out (broadcast the same prompt to the N
  siblings).
- **Depends on:** nothing hard (RF multi-select already exists).

### What it does
Multi-select Terminal boards and toggle "broadcast input" so a typed prompt/keystrokes go to all
selected terminals at once, with a tinted-border indicator on broadcasting boards. Targets the "send
the same prompt to several agents and compare" workflow.

### Why valuable
Canvas ADE's defining use case is running several agents side-by-side, each in its own worktree.
Broadcasting one prompt to N agents and visually comparing their diverging outputs across boards is
the parallel-agent pattern devs are adopting (iTerm2 broadcast-input, NTM broadcast prompts) — and
the spatial canvas is the ideal surface for it.

### Implementation sketch
- Multi-select already exists in React Flow node selection; broadcast state in the Zustand store.
- On input, fan out to each selected board's `pty.write` over its per-board MessagePort/IPC (input
  stays trusted-user-only).
- Indicator = board-chrome styling.
- **No new deps.**

### Viability checklist (run at ship time)
- [ ] RF multi-select state readable from the store to derive the broadcast target set.
- [ ] Per-board MessagePort fan-out works for N targets (one write → N `pty.write` calls); no
      cross-board port mixup.
- [ ] Clear visual indicator of which boards are receiving broadcast (avoid accidental sends).
- [ ] Broadcast respects the trusted-input boundary (no Browser content path).
- **Acceptance:** select 3 terminals, enable broadcast, type a prompt → all 3 receive it; disable →
      input returns to single-board.

---

# Dropped / deprioritized (with reason)

Kept here so a future session doesn't re-propose them without seeing the prior reasoning. Promote if
the reason no longer holds.

| Idea | Why not shortlisted | Revisit when |
|---|---|---|
| Per-board cost & token meter | Ties to reading Claude Code JSONL log internals = agent-specific, brittle vs the agent-agnostic `launchCommand` model. | Demand confirmed; or a stable cross-agent cost signal exists. |
| Approval inbox (respond to agent permission prompts centrally) | High effort: reliable cross-agent prompt detection + safe response injection. Partially overlaps SB-1's `awaiting-permission` state. | After SB-1 ships and detection proves reliable. |
| Handoff card (pass context between agents) | High effort; output-parsing/throttling risk. | After connectors (SB-4) land. |
| Agent-activity → Planning-notes routing | High effort; depends on connectors + output parsing. | After SB-4 + SB-2. |
| Frames / sections (group boards in a labeled container) | ADR 0002: frame chrome can't visually clip a live Browser board → blunts the headline appeal. | A non-occluding grouping visual is designed. |
| Tags + filter | Overlaps the status/minimap attention story. | If org needs exceed status+minimap. |
| Command blocks / OSC 133 (structured terminal blocks) | Medium effort for power-user-only payoff. | Power-user segment prioritized. |
| Network monitor (Browser board) | Heavier sibling of QW-4 console capture; kept the cheaper one. | After QW-4, if network insight demanded. |
| Spec/Plan/Tasks template, Decision cards, dependency-ordering arrows, quick-capture inbox, branch/worktree badge on checklists | Enrich Planning but several add a markdown-editor dep or depend on SB-2 Run-on-Agent + SB-4 connectors first. | After Run-on-Agent + connectors foundation. |

---

# Recommended sequencing

1. **Ship now (zero-dependency quick wins):** QW-3 scrollback search, QW-4 console capture. Pure
   additive, one-addon / one-listener, immediate value.
2. **In-flight merges (sequential, full gate + e2e after each):** Context #39 (merged) → MCP #32
   (lands SB-4 connector model + swarm layer) → rebrand #17 (last). Phase 3 persistence + runtime
   port detection (Slice C′) already shipped on main. FW-1 / Feature Workspaces (post-MCP) gates the
   remaining worktree-dependent proposals — SB-3, SB-5, OS-1 — and is scheduled after MCP (#32) lands.
3. **Highest-leverage single feature:** SB-1 status + attention queue. Only *medium* effort (glyph
   plumbing exists), answers the #1 multi-agent pain, and shares the camera-fly API with Focus/Full.
4. **Then the spatial/multi-agent chain:** SB-5 diff panel → SB-3 fan-out → OS-1 commit/merge/PR
   (all gated on FW-1); and SB-4 connectors (lands with #32) → SB-2 Run-on-Agent. QW-1 prompt-queue
   + QW-2 minimap slot in alongside SB-1.

---

## Source / provenance

- Research method: 6-agent dynamic workflow (5 research lenses — competitors, AI-agent workflow,
  canvas UX, terminal/preview, planning/knowledge — + 1 synthesis), web search + fetch, dedup of
  26 raw proposals → 14 shortlisted.
- Date: 2026-05-30.
- Cross-referenced against: `CLAUDE.md` (locked stack/decisions), `docs/roadmap.md` (phase order),
  `docs/decisions/0002-preview-gate.md` (native-view constraints), and the merged Phase 2 board
  source (`src/renderer/src/canvas/boards/*`).
