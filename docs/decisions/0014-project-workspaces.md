# ADR 0014 — Project workspaces (several isolated workspaces inside one project)

**Status:** Accepted · **Date:** 2026-11-03 · user decisions D-1…D-7 (2026-11-02) and O-1…O-12
(2026-11-03). Built as slices WS-0…WS-12; this ADR is WS-0.

- **Extends:** [ADR 0007](0007-schema-forward-compat.md) (a doc-level key raises the floor),
  [ADR 0009](0009-project-files-under-canvas-dir.md) (worktrees live inside `.canvas/`) and
  [ADR 0012](0012-update-levels.md) (the `minSupported` force switch).
- **Supersedes:** FW-1's "worktrees live outside the project working tree" constraint
  (`docs/feature-proposals.md`, 2026-05-30). Re-scopes MCP roadmap M6 (`docs/roadmap-mcp.md`) and
  the deferred Feature Workspaces entry (`docs/roadmap.md`).
- **Design record:** [`docs/research/2026-11-02-project-workspaces/README.md`](../research/2026-11-02-project-workspaces/README.md):
  the current-state map with line refs, the gap list, the option comparison and the slice plan.

## Context

A project is one folder and one canvas. Users run several streams of work inside one project: for
example `api/` building auth while `uploader/` reworks storage. That covers a polyrepo (several
repos under one root, like `M:\expanse`) and one repo on several branches. Today nothing keeps
those streams apart:

- A new terminal starts at the project root (`terminalSpawnMath.ts:74`). If its cwd is missing,
  `safeCwd` **silently starts it in `$HOME`** (`ptyShells.ts:69-76`). For confinement that is the
  worst failure: the agent runs, just somewhere else.
- MCP `spawn_board` / `configure_board` and Jarvis `spawn_board` accept any cwd, with no
  containment. A cwd-only `configure_board` is not even human-gated.
- Nothing records that an agent belongs to "API". Authority is the token tier plus cables plus
  `dispatchGate`, none of which is a filesystem boundary.
- Memory is flat per project, and `memory/project.md` is an LLM rollup. No per-stream brief exists
  that the user owns and agents read.

Two pieces already exist:

- **Worktrees shipped for the swarm** (orchestration S3, `src/main/swarmWorktree.ts`). The swarm
  allocates `<project>/.canvas/worktrees/<slug>` on branch `swarm/<run>/<worker>`. It proves the
  directory exists before handing it over, removes without `--force`, offers
  commit / stash / discard / keep on a dirty tree, and never deletes a branch. It is
  **project-rooted**, though: it probes the *project* dir for a repo, so a polyrepo is refused
  (`:197-206`). It removes from the project dir and always branches off `HEAD` (`:244`).
- **Named groups and the I1/I2/I3 spatial lanes** give a cluster of boards a zone: membership
  tools, `canvas://contexts`, scoped tidy (`scope: { boardIds }`) and group tidy in place. A group
  cannot carry a root or a lifecycle, though. A board may sit in many groups, empty groups are
  dropped on load, and MAIN's mirror rebuilds only `{id, name, boardIds}`.

The old plan was FW-1 / MCP M6, "Feature Workspaces", deferred 2026-05-30. It made zones
worktree-only and put the worktrees *outside* the project tree. Then S3's design D1 was signed
off on 2026-07-28 and shipped: it puts them *inside*, under `.canvas/worktrees/`. The two
documents have contradicted each other since.

## Decision

A **workspace** is a folder inside the project, optionally backed by a git worktree + branch of
the repo that contains that folder (D-1). It also has member boards, a one-line goal and a shared
brief. One project holds any number of workspaces on **one shared canvas**, as spatial regions:
switching is a focus or filter, never a reload (D-2). A board belongs to **zero or one** workspace;
a board with none is **project-level** (D-3).

### 1. Data model: Option B, a doc-level `workspaces[]` + `board.workspaceId` (schema v24 / floor 24)

- `canvas.json` gains two root keys:
  - `workspaces`, where each entry has `id`, `name`, `goal`, `color`, a project-relative `root`,
    an optional `worktrees[]`, `state?: 'archived'` and `keepLayout?`;
  - `repoDefaults`, the base branch remembered per repo (§2).

  Every board gains an optional `workspaceId`. Because membership is a field on the board, D-3's
  0-or-1 rule holds by construction.
- These are new doc-level keys, so the bump is **v24 with floor 24**, per ADR 0007's table. An
  older app refuses the doc instead of silently dropping `workspaces` on its next save. §7 makes
  that refusal force an update.
- Paths are stored project-relative, so `canvas.json` stays portable. MAIN resolves and realpaths
  them. A root outside the project is refused in v1 (O-7). `worktrees` is a list, so multi-repo
  workspaces later need no second format change; v1 validation rejects more than one entry (O-10).
- Creating or deleting a workspace is **off the undo rail**, because it has irreversible side
  effects (worktree add/remove); it is settings-class, like the backdrop. Assigning a board to a
  workspace, or removing it, is an ordinary undoable patch.
- On workspace delete, its boards stay as project-level boards (O-8) unless the user chooses to
  close them.
- MAIN mirrors workspaces through a new bounded sanitizer and is the authority for every root
  lookup. Machine-local view state (the active workspace, the filter) lives in
  `.canvas/session.json`.
- **Groups are unchanged** and may span workspaces. For spatial tooling, MAIN projects each
  workspace as a **read-only synthetic group** with the same id. `tidy_canvas`, `focus_viewport`
  and Jarvis focus then work on workspaces with no package change, and `edit_groups` /
  `group_boards` refuse workspace ids.

### 2. One worktree allocator, generalized

- `swarmWorktree.ts` is **generalized, not forked**. Its entry point becomes
  `allocate({ repoDir, slug, branch, base?, attach? })`. The swarm passes its own branch and the
  default base `HEAD`, so swarm behaviour is unchanged.
- The git probe runs on the **workspace's repo** (`repoDir`, which must sit inside the project),
  not on the project dir. That fixes polyrepos. Remove and dispose run `git -C <owning repo>`,
  never from inside the worktree.
- **Location: `<project>/.canvas/worktrees/<slug>`** for the swarm and for workspaces alike, under
  one shared `owns()` containment root (workspace slugs are `ws-<slug>`). This is S3's D1: inside
  ADR 0009's boundary and already hidden from the File Tree. **It supersedes FW-1's "outside the
  project working tree"** (O-1).
- **Branches.** A new branch is named `ws/<slug>` and starts from a base branch the user picks.
  **The base is remembered per repo** in `repoDefaults`, keyed by the project-relative repo root.
  It is asked the first time and pre-filled after that. A remembered base that no longer exists
  falls back to `HEAD`, and the dialog says so. Attaching an existing branch is also supported.
  Expanse never runs `git fetch` on its own.
- **Modes:** use the folder as-is (the default; needs no git) · new worktree + branch · attach an
  existing branch. A folder that is not a repo disables the git modes; Expanse never runs
  `git init`.
- **Delete:**
  - A clean worktree is removed with `git worktree remove`, without `--force`.
  - A dirty one is kept on disk and the user is prompted: commit / stash / discard / keep.
  - **Keep** archives the record, so a kept worktree is never orphaned.
  - **Branches are never deleted.**
- Before reading a worktree's status, Expanse removes the config files it provisioned there, so
  its own files never make a clean tree read as dirty.
- **Dependencies (O-9):** an opt-in checkbox. When it is ticked, the workspace's agent is asked
  once to install dependencies, because the agent can tell pnpm, pip and the rest apart. Expanse
  never runs an install command itself.
- The locked rules in `CLAUDE.md` › *Git / worktrees* bind unchanged.

### 3. cwd resolution: `strictCwd`, which never falls back to `$HOME`

- The renderer proposes and **MAIN decides**. A workspace board's cwd is
  `board.cwd ?? workspace.effectiveRoot`. The effective root is the workspace root, remapped into
  its worktree when it has one.
- MAIN looks the workspace up in **its own mirror** and never trusts a root sent by the renderer.
  It realpaths both paths and requires the cwd to be inside the effective root.
- A new **`strictCwd`** fails the spawn with a plain sentence when the directory is missing, is
  not a directory, or escapes the root. For example: *Workspace "API" folder is missing (api/).*
  **It never falls back to `$HOME`.** Project-level boards keep `safeCwd`, so their behaviour is
  unchanged.
- The PTY env gains `CANVAS_WORKSPACE_ID`, `CANVAS_WORKSPACE_ROOT` and `CANVAS_WORKSPACE_CONTEXT`.

### 4. Confinement: enforce what Expanse owns (D-4)

Expanse hard-refuses on its own surfaces and adds per-CLI config as best effort.

- **Caller scope.** An MCP caller's board id comes from its token. That board's `workspaceId`
  gives scope **W** (a workspace) or **PROJECT** (no workspace). Jarvis is always PROJECT, and
  every Jarvis write is already human-confirmed. The checks live in a new `workspaceScope.ts`.
- **`spawn_board`:**
  - From a W caller, the new board joins W, and its cwd must be inside W's root.
  - From a PROJECT caller, a cwd inside some workspace's root joins that workspace.
  - **A cwd outside the project is refused for every caller.** This rule is new.
- **`configure_board` cwd:** the target board must be in the caller's scope, and the new cwd must
  stay inside the target's workspace. Only the user, in the UI, can move a board between
  workspaces.
- **Relay, handoff and assign** from W to a terminal in another workspace are **refused
  outright** (O-4). PROJECT callers may reach any workspace through the existing confirms (O-3).
- **Planning, card and close writes** from W into another workspace's boards are refused.
  Project-level boards stay writable, so a shared kanban keeps working.
- **Jarvis `spawn_board`** gets the same containment as a PROJECT caller.
- **Per-CLI config (O-5).** Each workspace's `.claude/settings.local.json` gets Claude Code
  `permissions.deny` `Edit(//<abs>/**)` rules for:
  - every other workspace root;
  - sibling worktrees;
  - `.canvas/canvas.json`;
  - `.canvas/workspaces/**`.

  On macOS, Linux and WSL2 the same file also gets `sandbox.enabled`. Both edits merge with the
  user's own settings and are swept on consent revoke.
- **Limits, documented plainly:**
  - None of this stops a shell agent from running `cd ../uploader && …`.
  - Claude Code deny rules govern its Edit tool, not Bash redirects.
  - Its sandbox does not exist on native Windows.
  - codex and gemini keep machine-global config, which cannot be scoped per workspace.
  - Whether a `//m/...` deny rule holds on Windows is unverified; WS-8 starts with a spike.

### 5. Shared context: live status + my notes (D-6, O-6)

- **One brief per workspace,** `.canvas/workspaces/<id>/CONTEXT.md`. A project brief,
  `.canvas/workspaces/_project/CONTEXT.md`, rolls them all up.
- **The top half is live status, which Expanse writes.** It covers the goal, the branch, the
  in-progress cards and checklist items, what the agents are doing, and recent results. It is
  built deterministically (no LLM, no network), so it needs no consent gate.
- **The bottom half is the user's notes.** Expanse never drops user text.
- **The writer:**
  - only touches the block between its markers;
  - runs at most once every 5 s per workspace and skips writes that change nothing;
  - re-reads the file and checks its mtime before an atomic rename;
  - pauses while the Brief board has unsaved edits;
  - re-inserts a status block at the top if the user deleted the markers.
- **Agents read the brief live but never write it.** In v1 they find it through the env var and
  the launch hint; an MCP resource comes later. A deny rule covers `.canvas/workspaces/**`. The
  brief is never injected into the user's repo (no `CLAUDE.md` write).
- The user reads it on a **Brief** board (a File board bound to the file) placed at the zone's
  top-left. It replaces the earlier `digest.md` idea, and it is distinct from
  `memory/project.md`.

### 6. Switching, and focus that fills the screen like Tidy (D-5, D-7, O-12)

- **Switching.** There is a workspace chip in the app chrome, number keys, and a rebindable
  commit-on-release hotkey cloned from the running-project switcher. A switch is a focus and
  filter, not a reload. Every workspace keeps running; unlike a project switch, nothing is parked.
- **Every focus repacks, places and frames the workspace:**
  1. It repacks that workspace's boards toward the pane's aspect, using the Fit layout.
  2. It places them by I3's group-tidy rule: anchor at the zone's top-left, and if that collides,
     move the whole workspace to free space. **Boards outside the workspace never move.**
  3. It frames the result.

  This is the same engine call as **Tidy group**,
  `runTidyAndReport({ mode: 'fit', overflow: 'report', scope: { boardIds } })`, so no new engine
  is needed.
- **Focus rules:**
  - A focus is one undo step, or none when nothing moved.
  - A window resize re-fits the focused workspace live, off the undo rail.
  - Below readable zoom, focus reports the problem; it never shrinks boards without asking.
- **Keep my arrangement** is a per-workspace opt-out (default off). With it on, focus only moves
  the camera.
- Agent-driven `focus_viewport` stays camera-only. Rearranging boards on an agent's behalf goes
  through `tidy_canvas` and its confirm.
- **View filter:** All · Dim others (the default while a workspace is active) · Solo. Solo hides
  the other workspaces from render while their PTYs keep running.

### 7. A format change forces an update, on both feeds (O-2)

- **Detection.** Both release scripts (`release.mjs` through `gen-updates-json.mjs`, and
  `release-local.mjs`) record `minReaderVersion` in `updates.json`. Each compares it with the
  value the **previous** feed recorded.
- **When the floor rose,** the release sets `minSupported` to its own version. Every older app
  then gets ADR 0012's blocking modal. This applies on the production feed **and** the local feed.
- **Otherwise nothing changes.** Tiers stay as they are, and an ordinary local release still never
  forces. This narrowly reverses `release-local.mjs`'s "never a floor" rule, for format changes
  only.
- **The "saved by a newer version" open error gets an Update now button.** It covers an app that
  has not checked the feed since the release, and the fail-open case.
- **Order:** WS-12 (this mechanism) ships in a release **before** WS-2's v24 release.

### Naming

| Term | Means |
|---|---|
| **Workspace** | The user-facing isolation unit: a root (plus an optional worktree and branch), a goal, a brief and member boards. "Feature" is dropped, because any folder qualifies. |
| **Zone** | A workspace's on-canvas region (outline + tab). Visual only, never a data entity. FW-1/M6's "feature zone" sense is retired. |
| **Group** | Unchanged: a free-form, multi-member named cluster for navigation and layout. |
| **Brief** | A workspace's (or `_project`'s) `CONTEXT.md`. |
| **Project-level** | A board with no workspace. Its cwd is the project root, as today. |

Jarvis's `Workspace:` manifest header, which means the whole canvas, is renamed `Canvas:` (WS-10)
to end the name clash.

## Alternatives rejected

- **A · Extend `NamedGroup` with a workspace payload:** groups are multi-member, drop when empty
  and ungroup without a dirty prompt, so D-3 and the worktree lifecycle break, and it raises the
  floor to 24 anyway.
- **C · One canvas per workspace (`.canvas/workspaces/<id>/canvas.json`):** switching becomes a
  reload (violates D-2), cross-workspace cables and a shared plan are lost, and project open/switch,
  background sessions (ADR 0011) and MCP routing all need re-plumbing.
- **Sidecar variant of B (`.canvas/workspaces.json`, no floor bump):** an older app would silently
  run workspace terminals at the project root, unconfined; a floor refusal plus a forced update is
  the safer failure, and it avoids two-file consistency and a cross-file undo rail.

## Consequences

- **A project with no `workspaces` behaves exactly as today,** and project-level boards keep
  `safeCwd`. No migration is required. Two assists are follow-ups: "Make workspace from group",
  and "Suggest workspaces" from `deriveContexts` cwd clusters.
- **v24 is the first floor raise under the force rule.** After that release, every older install
  must update, including installs that never open a workspace project. The user accepted this.
  Fail-open stays: an offline app cannot be forced, which is what the Update now button is for.
  Dev builds never auto-update, and the ESCHEMAFLOOR guard still keeps them from raising a real
  project's floor.
- **The swarm allocator becomes shared infrastructure.** Swarm behaviour must stay identical, and
  WS-1 carries parity tests for it.
- **Confinement is real on Expanse-owned surfaces and best effort everywhere else.** User-facing
  docs must say that a raw shell can escape.
- **MCP v1 needs no package publish:** the synthetic-group projection and tool errors cover it.
  The richer surfaces come later as one publish plus a pin bump (WS-9): `canvas://workspaces`,
  `canvas://workspace/context`, `spawn_board.workspace` and a caller-scoped `canvas://boards`.
- **Two worktrees of one repo default to the same dev port.** Expanse detects ports and doesn't
  assign them (Slice C′), so the second server has to pick another port. That is UX copy, not new
  machinery.
- **`.canvas/workspaces/` is private by default.** With the commit opt-in it is tracked, so a team
  can share notes. `repoDefaults` lives in `canvas.json`, so a committed canvas shares "api
  branches off `release`".
- **UI slices need a design artifact first.** WS-4 (create/delete dialogs) and WS-5 (zones, chip,
  switcher) each need a signed-off artifact before code, per `CLAUDE.md` › *Design artifact before
  code*.
- **The slice plan is §5 of the design record.** The MVP for the API/Uploader example is WS-1, 2,
  3, 4, 5, 7, 8 and 12; WS-6, 9, 10 and 11 are follow-ups.
