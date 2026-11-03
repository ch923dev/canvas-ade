# Project Workspaces: several isolated workspaces inside one Expanse project

**Date:** 2026-11-02 · **Base:** `main` @ `410ded22` (v0.47.20, `@expanse-ade/mcp` 0.27.1 pinned, schema v23 / floor 23)
**Type:** research + design. No code changed. **Status:** design agreed. The user answered every open decision on
2026-11-03 (§0). **I1, I2 and I3 have all merged** (re-checked 2026-11-03 at `main` @ `0bdccf66`: v0.47.26,
`@expanse-ade/mcp` 0.28.1 pinned, schema still v23 / floor 23). The O-11 gate is met, and the build can start.
**Line refs** are at `410ded22` unless §1.9 lists a newer one. §1.9 covers what the three merges changed.

This is the deferred **Feature Workspaces** epic (FW-1 / MCP M6), re-scoped. A workspace is backed by a
**folder, or optionally a git worktree + branch**. It was originally worktree-only.

## 0. Goal and locked inputs

**Goal.** One project holds N workspaces. Example, both in the same project:

| Workspace | Root | Goal |
|---|---|---|
| API | `<project>/api` | build auth |
| Uploader | `<project>/uploader` | enhance storage |

Per workspace, "isolated" means all of the following:
- its own root dir, optionally a git worktree + branch;
- its own boards;
- terminals that start in its root;
- browser previews that follow its dev server;
- its own plan;
- a **shared context brief** the user can read and edit at any time;
- agent config, memory and MCP reach that don't bleed into other workspaces.

By default, agents in API never write into Uploader's files.

**Decided by the user (2026-11-02). Do not re-litigate.**

| # | Question | Answer |
|---|---|---|
| D-1 | Folder vs git | **Both.** A workspace root is any folder inside the project. Optionally, back it with a worktree + branch of the repo that contains that folder. This covers a polyrepo (`M:\expanse` style: separate repos under one root) **and** one repo on different branches. |
| D-2 | Canvas model | **One shared canvas with zones.** All workspaces are on one canvas as spatial regions. Switching is a focus/filter, not a reload. |
| D-3 | Membership | **0 or 1 workspace per board.** A board with no workspace is **project-level**. Plain groups keep multi-membership. |
| D-4 | Confinement strength | **Enforce what Expanse owns.** Expanse hard-refuses on its own surfaces: MCP/Jarvis spawn and configure, relay, its own writes, workspace-scoped agent config and memory. It adds per-CLI permission config as best-effort. A raw shell `cd ..` is out of reach, and that limit is documented. |
| D-5 | Switching (added mid-task) | There must be a **simple way to switch workspaces**. |
| D-6 | Shared context (added mid-task) | Each workspace has **shared context the user can read**. It is living: the user adds to it whenever they want, and agents see the current version. Its shape was settled in O-6: **live status + my notes** (§4.5). |
| D-7 | Focus behaviour (added mid-task) | **Focusing a workspace fills the screen, like Tidy.** Its boards are repacked to the screen's shape and framed; focusing the next one does the same for it. See §4.6. |

**Open decisions, answered by the user (2026-11-03). Do not re-litigate.**

| # | Question | Answer |
|---|---|---|
| O-1 | Worktree location | `<project>/.canvas/worktrees/<slug>`, the S3 D1 location. WS-0 marks FW-1 `feature-proposals.md:112` superseded. |
| O-2 | Where `workspaces[]` lives | In `canvas.json` (**v24 / floor 24**). **Added:** every release that changes the `canvas.json` format forces older apps to update, on the production feed **and** the local feed (§4.9). |
| O-3 | Project-level agents | May spawn into and write to any workspace, each through the existing confirms. |
| O-4 | Cross-workspace relay | A workspace agent's relay to another workspace is **refused outright**. |
| O-5 | Agent config | Add Claude Code `permissions.deny` rules to each workspace's `.claude/settings.local.json`, **and** set `sandbox.enabled` on macOS/Linux/WSL2. |
| O-6 | Context | **Live status + my notes**, in one file per workspace under `.canvas/workspaces/<id>/`. Expanse writes the status half; the user owns the notes half; agents only read it. This replaces the `digest.md` idea (§4.5). |
| O-7 | Roots outside the project | Refused in v1. |
| O-8 | Boards on workspace delete | They stay, as project-level boards. |
| O-9 | Dependencies in a fresh worktree | An opt-in checkbox. When ticked, **the agent** is asked to install dependencies, because it can tell pnpm, pip and the rest apart. Expanse never runs a fixed install command (§4.3). |
| O-10 | Branches | New branches are named `ws/<slug>`. The **base branch is asked the first time per repo and remembered** (e.g. api → `release`, extension → `upgrade-manifest`). In a polyrepo, New Workspace lists every git repo it finds. v1 backs a workspace with **one** repo; worktrees are stored as a list, so multi-repo workspaces can come later without another format change (§4.1, §4.3). |
| O-11 | Order | **Wait until I2 and I3 have both merged,** then start. The package's unreleased 0.28.0 ships with the WS-9 publish. **Update 2026-11-03:** both have merged, so the gate is met. 0.28.x was published and pinned in #445 (package HEAD = pin = 0.28.1), so there is no unreleased package work left to fold into WS-9. |
| O-12 | When focus rearranges | On **every** focus, with a per-workspace **Keep my arrangement** opt-out. Resizing the window re-fits the focused workspace live. |

**Locked rules that bind** (from `CLAUDE.md:88-92`, unchanged):
- `git init` is opt-in. Reuse an existing repo. Never nest-init.
- A dirty worktree is kept on disk and the user is prompted (commit / stash / discard / keep).
- Always `git worktree remove`, never `rm -rf`.
- `simple-git` runs in MAIN only, behind frame-guarded IPC.

S3 added one more rule: **branches are never deleted by Expanse** (`swarmWorktree.ts:27-28`).

**Evidence tags.**
- **[V]**: I read the cited line(s) this session.
- **[V†]**: a recon sub-agent read and quoted it this session; not re-read by me.
- **[I]**: inferred, not traced end-to-end.
- **[DOC]**: external Claude Code documentation, fetched this session (URLs in the Appendix).

---

## 1. Current-state map

### 1.1 Project, canvas, persistence

| Piece | Fact | Where | Tag |
|---|---|---|---|
| Project model | "A **project = one canvas**." | `CLAUDE.md:8` | [V] |
| Active project | One module-global `currentDir` (`getCurrentDir`/`setCurrentDir`). Exactly one foreground project per app. | `src/main/projectStore.ts:100-106` | [V] |
| Background projects | Other projects park as background sessions. PTY sessions are tagged with their owning project, because board ids collide across copied projects. | `src/main/pty.ts:159-163`, `:522`, `:816-818` | [V†] |
| Persistence | `.canvas/canvas.json` + `.bak`; memory/audit/tmp live under `.canvas/` (ADR 0009). | `CLAUDE.md:74` | [V] |
| Session sidecar | `.canvas/session.json` holds the machine-local viewport + backdrop. It is settings-class and git-ignored. | `src/main/projectStore.ts:32` | [V] |
| Schema | `SCHEMA_VERSION = 23`, `MIN_READER_VERSION = 23`. | `src/renderer/src/lib/boardSchemaVersion.ts:117`, `:163` | [V] |
| ADR 0007 | A **new doc-level key bumps the floor**, because an older reader's save silently drops unknown root keys. | `docs/decisions/0007-schema-forward-compat.md:55` | [V] |
| Board base | `BoardCommon = {id,type,x,y,w,h,title,z?}`. There is no workspace or owner field. | `boardSchema.ts:136-145` | [V] |
| Terminal cwd | `cwd?: string`. A plain optional string. | `boardSchema.ts:151` | [V] |
| `.canvas` ignore | Private (default) ignore body = `*\n!canvas.json\n`. Committed opt-in body = `audit/ tmp/ terminal/ worktrees/ canvas.json.bak session.json`. | `src/main/canvasMemory.ts:32`, `:39` | [V] |
| File Tree | `.canvas/` is hidden from the tree **at the root only**. Reads are not blocked there. | `src/main/fileIpc.ts:36-37`, `:207` | [V] (that a File board can bind a `.canvas/...` path is [I]) |

### 1.2 Groups, contexts, spatial lanes (I1/I2/I3)

| Piece | Fact | Where | Tag |
|---|---|---|---|
| `NamedGroup` | `{id, name, boardIds}`. Comment: "A board may belong to MANY groups (multi-membership is intentional)… Forward-compatible with the deferred Feature Workspaces phase, which will add an optional `worktreePath`". | `boardSchema.ts:487-498` | [V] |
| Group load | `reconcileGroups` **spreads `...g`**, so unknown group fields survive an older reader. It also **drops zero-member groups** ("empty groups never persist"). | `boardSchema.ts:1143-1159` (spread `:1157`, drop `:1158`) | [V] |
| Group mirror to MAIN | `sanitizeGroups` **rebuilds** `{id, name, boardIds}`, so extra fields never reach MAIN. | `src/main/boardRegistry.ts:794-817` (`:813`) | [V] |
| Group store | `pruneBoardFromGroups`, `createGroupSlice` (add/remove/rename/addBoardsToGroup). | `src/renderer/src/store/slices/groupSlice.ts:24`, `:33` | [V] |
| Group UI | `GroupBoxLayer.tsx` (zone outline + tab; Enter focuses), `GroupContextMenu.tsx` (Rename · Focus · Add selected · Remove), `GroupFocusPicker.tsx`. The `f` key opens group focus. | `canvas/GroupBoxLayer.tsx:102`, `canvas/AppChrome.tsx:40-41` | [V] |
| `deriveContexts` | Rule 2: "Named Groups are authoritative." Rule 4: ungrouped boards cluster on strong edges plus **cwd**. Rule 7: naming falls back to "common cwd basename". So it already proposes "api"/"uploader" clusters from today's boards. | `src/shared/deriveContexts.ts:9`, `:15`, `:22`, `:484` | [V] |
| Focus by group | Command `focusCamera {boardId?, groupId?}` is on main. | `src/shared/mcpTypes.ts:463` | [V] |
| Group focus today | `fitGroup` is **camera-only**: `rf.fitView` over the members where they already sit. No board moves. | `src/renderer/src/canvas/hooks/useGroupInteractions.ts:84-99` | [V] |
| Tidy today | `tidyAndFit` repacks boards toward the pane aspect (`tidyBoards(mode, paneW/paneH)`), then `fitToBoards`, so the result fills the screen. Tile presets also re-tile live on window resize, untracked in undo. | `src/renderer/src/canvas/hooks/useTidyTile.ts:109-123`, `:126-140`; rationale `src/renderer/src/lib/canvasView.ts:24-37` | [V] |
| Fit layout (on main; I2 wires it) | Screen-aware packing: each group/context is packed as a unit, then units are shelf-packed toward the pane aspect. Below `READABLE_ZOOM` 0.4 it reports, cuts pages, or shrinks. | `src/renderer/src/lib/fitLayout.ts:1-21`; `src/shared/spatialGeometry.ts:23`, `:25` | [V] |
| Tidy scope | **Now accepted** (I2 + I3): `'all' \| 'visible' \| { groupId } \| { boardIds }`, up to 500 ids. A partial scope settles in place, and moves as a whole on collision. *(Before the I2 merge it was refused: `mcpTidy.ts:34-37` @ `410ded22`.)* | `src/shared/tidyContract.ts:37`, `:47`; `src/renderer/src/store/spatialTidy.ts:340-350` @ `0bdccf66` | [V] |
| Wire id | `spatialIdSchema = z.string().min(1).max(...)`. Any id string passes as a `groupId`. | `canvas-ade-mcp/src/server/tools/spatialShared.ts:37` | [V] |
| **I1** group tools | `group_boards` / `edit_groups` / `canvas://contexts` host methods. **Merged** 2026-11-02 (#442, `46873865`, v0.47.22). Before the merge the host marked these tools pending (`HOST_PENDING_TOOLS`). | `M:\expanse\lane-i1-groups-kickoff.md`; `src/main/appModelDrift.test.ts:50` @ `410ded22` | kickoff [V]; merge [V] (`git log origin/main`, `gh pr list`, 2026-11-03) |
| **I2** tidy | Forwards `mode`/`scope` (including `{groupId}`) and the Fit/role tidy. Adds the "Focus group" toast. Jarvis `tidy_canvas` gains `boardIds`. **Merged** 2026-11-02 (#443, v0.47.23; follow-up #444 lazy-loads the tidy engine). | `M:\expanse\lane-i2-tidy-kickoff.md`; `gh pr list` | [V] |
| **I3** group tidy | Tidies one group in place and moves it as a whole to free space; neighbours never move. **Merged** 2026-11-03 (#446, `fdd4af5e`, v0.47.26). Adds `placeScoped` and the group menu's **Tidy group**. | `src/renderer/src/lib/groupTidyPlace.ts:68`; `GroupContextMenu.tsx:37`; `useTidyTile.ts:150-157` @ `0bdccf66` | [V] |

**Verdict.** I1/I2/I3 give a workspace its **zone**: membership tooling, an agent-readable context map, focus,
tidy-in-place and a contiguous region. They do **not** give it a root, cwd, confinement or lifecycle. Those are
the gaps in §2.

### 1.3 cwd resolution and spawn

| Piece | Fact | Where | Tag |
|---|---|---|---|
| Renderer fallback | `cwd: board.cwd ?? projectDir ?? undefined`. | `src/renderer/src/canvas/boards/terminal/terminalSpawnMath.ts:74` (fn `:64-77`) | [V] |
| MAIN guard | `safeCwd` returns cwd only if it is an existing directory, **else `os.homedir()`, silently**. | `src/main/ptyShells.ts:69-76` | [V] |
| Spawn | `const spawnCwd = safeCwd(opts.cwd)`. | `src/main/pty.ts:771` | [V] |
| Spawn env | Only `CANVAS_RECAP_BOARD=<boardId>` (consent-gated) plus scrub/hint vars. No project or workspace id. | `src/main/index.ts:476-477`, `src/main/ptySpawnEnv.ts:169-179` | [V†] |
| Swarm override | "The worktree WINS over any cwd the model proposed". | `src/main/swarmTools.ts:598` | [V] |

### 1.4 Worktrees: the one allocator (`src/main/swarmWorktree.ts`)

All rows [V]:
- **Location** is `<project>/.canvas/worktrees/<slug>` (`:40`, `:132-135`). This was S3 design **D1**, signed off 2026-07-28: "inside the ADR 0009 isolation boundary, already hidden from the File Tree" (`docs/orchestration/s3-design-artifact.html`).
- **Branch** is `swarm/<runId8>/<worker-slug>[-n]` (`:43`, `:126-129`).
- **The repo must be the project.** It runs `checkIsRepo()` **on the project dir**, then `--show-toplevel` (`:197-206`). A polyrepo project such as `M:\expanse` (not a repo itself) is **refused**.
- **Create** runs `git worktree add -b <branch> <path> HEAD` (`:244`), then proves the dir exists. This is the guard against the `safeCwd` → `$HOME` trap (`:248-255`, `:10-14`).
- **Status:** `git status --porcelain` counts untracked files (`:148-151`). An unreadable tree reads as dirty (`:266-269`).
- **Remove:** `removeIfClean` runs `git worktree remove` without `--force`, **from the project dir** (`:283-293`). In a polyrepo the project dir is not a repo, so this call would fail.
- **Dirty disposition:** `dispose(commit|stash|discard|keep)` re-checks dirtiness first (TOCTOU). Discard is `checkout -- .` + `clean -fd`. The branch is always kept (`:300-349`).
- **Containment guard:** `owns()` passes only paths strictly under `<project>/.canvas/worktrees/` (`:175-183`).
- **Callers:** the swarm only (`swarmTools.ts:501-504`, `swarmChatIpc.ts`). Role packs declare `isolation: 'none' | 'worktree'`, and `writeScope` is advisory (`src/shared/rolePacks.ts:60-61`, `:69`, `:88`).

### 1.5 MCP / agent surfaces

| Surface | Fact | Where | Tag |
|---|---|---|---|
| `spawn_board` cwd (app) | `const cwd = hasCwd ? input.cwd!.trim() : undefined`. Trim only; then `addBoard {...cwd}`. **No containment, no existence check.** | `src/main/mcpLifecycle.ts:255`, `:291`, `:325` | [V] (`:255` read; `:291`/`:325` [V†]) |
| `spawn_board` cwd (package) | `cwd: z.string().optional()`. The description says invalid paths fall back to home. | `canvas-ade-mcp/src/server/tools/spawnBoard.ts:~48` | [V†] |
| `configure_board` cwd | Refused on a RUNNING terminal (`:495-496`). A cwd-only change is "**no exec vector**", so it goes through **without a human gate** and is audited only. | `src/main/mcpOrchestrator.ts:495-496`, `:610-616` | [V] |
| Jarvis `spawn_board` | `cwd: {type:'string', maxLength: 400}`. User-confirmed, **not contained**. | `src/main/jarvisTools.ts:133-148` (`:142`) | [V] |
| Caller identity | Tokens are minted per board id and tier (`lead` vs `connected`). The caller's board id is token-derived, never client-supplied. | `src/main/mcp.ts:363-365`; `mcpLifecycle.ts:~239-247` | [V] / [V†] |
| Relay gate | Relay requires an orchestration cable. `dispatchGate` is the single PTY-write gate (nonce + confirm). Neither is a filesystem gate. | `src/main/mcpOrchestrator.ts:905-923`; `src/main/dispatchGate.ts` | [V†] |
| Board reads | The package scopes `canvas://boards` and summaries **for the worker tier only**. `canvas://memory` has no scope. | `node_modules/@expanse-ade/mcp/dist/index.js:329`, `:340`, `:348` | [V†] |
| Containment helpers | `isWithin(rootAbs, candidate)` is **private** (`path.relative`-based). `resolveWithinRoot` is lexical and relative-only. `realResolveWithinRoot` adds realpath + a junction re-check. | `src/main/pathSafe.ts:41-44`, `:52`, `:121` | [V] |
| Package version | The package repo HEAD is 0.28.1 (`arrange_main_board`), and the app pins 0.28.1 (#445). Nothing is unreleased. | `canvas-ade-mcp/package.json:3`; `expanse-desktop/package.json:61` @ `0bdccf66` | [V] |

### 1.6 Agent config, memory, context (bleed surfaces)

| Piece | Fact | Where | Tag |
|---|---|---|---|
| Provisioner target | `targetDir = cwd \|\| projectDir`. It writes **per cwd**, gated by **project** consent, then `recordProvisionedDir(projectDir, targetDir)`. | `src/main/cliProvisioners/index.ts:318`, `:323-327` | [V] |
| Claude Code files | Writes `<dir>/.mcp.json` (only the `canvas-ade` entry, bearer = the board's token) and `<dir>/.claude/settings.local.json` (`enabledMcpjsonServers`). | `src/main/cliProvisioners/claude.ts:31-35`, `:38-48`, `:57-63` | [V] |
| Last writer wins | One `canvas-ade` entry per file. Two boards in one cwd overwrite each other's token. **Different cwds get different files**, so `api/` and `uploader/` are already separate by construction. | same | [V] (effect on a running agent: [I]) |
| codex / gemini | They write `~/.codex/config.toml` and `~/.gemini/settings.json`. These are **machine-global**, last writer wins across every board and project. | `cliProvisioners/codex.ts:29`, `gemini.ts:28` | [V†] |
| Cleanup | Only on consent revoke, swept via the `provisioned-dirs.json` ledger. Nothing is cleaned on board close. | `cliProvisioners/index.ts:249`; `provisionedDirStore.ts:12` | [V†] |
| Memory layout | Flat `.canvas/memory/`: `MEMORY.md`, `project.md`, `board-<id>.md`, `board-<id>.recap.json`, run ledgers. **No grouping.** | `src/main/canvasMemory.ts:116-130` | [V] |
| `project.md` | An **LLM-generated rollup** (`buildProjectRollup`) from the autonomous summary loop. It is not a human-authored brief. | `src/main/summaryLoop.ts:733` | [V] |
| Claude Code discovery | `.claude/settings*.json` is read from the session's **primary working directory only, no walk-up**. `CLAUDE.md` **walks up** to the filesystem root. Whether `.mcp.json` walks up is not documented. | code.claude.com settings / permissions / memory / mcp | [DOC] |
| Claude Code confinement | Path rules take `Edit(//abs/**)` (absolute; Windows normalizes to `//c/...`). `deny` in local settings applies immediately. Rules don't cover Bash redirects. **The sandbox is unavailable on native Windows.** | code.claude.com permissions / sandboxing | [DOC] |

### 1.7 Browser preview, planning, Jarvis, switchers

| Piece | Fact | Where | Tag |
|---|---|---|---|
| Preview link | `BrowserBoard.previewSourceId`: the terminal that pushed the URL. It is per board and re-detects from its source terminal's ports. | `boardSchema.ts:219-226`; `useBrowserAutoConnect.ts:97-100`; `previewTarget.ts:61` | [V] / [V†] |
| Planning | Checklists are elements inside a Planning board. A plan is just a board. | `boardSchema.ts:386-388`, `:309` | [V†] |
| File board | v13 on-canvas file viewer/editor. `path` is project-relative and content is read live from disk. | `boardSchema.ts:230-243` | [V] |
| Jarvis groups | `focus_viewport` takes `group` through `resolveGroupRef`. The manifest tags `group:Name`. `tidy_canvas` has an empty schema on main. | `jarvisTools.ts:326`, `:421`; `jarvisManifest.ts:66` | [V] / [V†] |
| Jarvis naming | The system prompt header is literally `Workspace:\n${manifest}`, so "workspace" already means "the whole canvas" there. | `src/main/jarvisPersona.ts:132` | [V] |
| Project switcher | `RunningProjectSwitcher.tsx` is an Alt-Tab overlay that commits on release. The hotkey is MAIN-bound and rebindable. | `src/renderer/src/canvas/RunningProjectSwitcher.tsx:2-13` | [V] |

### 1.8 Stale docs and comments (fix in WS-0)

| Doc / comment | Claim | Reality |
|---|---|---|
| `M:\expanse\docs\orchestration\01-current-state.md:244` (§A6, July 2026) | "No git worktree/branch/clone handling in product code" | **STALE.** `swarmWorktree.ts` (S3) allocates, removes and disposes worktrees. [V] |
| same `:245`, `:251` | "nothing allocates… a directory per agent"; "only isolation = profile" | **PARTLY STALE.** Swarm write roles get worktrees (`swarmTools.ts:598`). Non-swarm boards are unchanged. [V] |
| same `:254` | `configure_board` cwd change is "human-confirmed durable config" | **STALE.** A cwd-only change is un-gated, "no exec vector" (`mcpOrchestrator.ts:610-616`). [V] |
| same `:244`, `:252` line refs | `boardSchema.ts:429` NamedGroup, `mcpLifecycle.ts:212` | Drifted. Now `:494` and `:255`/`:291`. [V] |
| same `:246`, `:247`, `:252` | safeCwd → `$HOME`; shared cwd; uncontained MCP cwd | **Still true.** [V] |
| `CLAUDE.md:82-92` "Git / worktrees — DEFERRED" | worktrees are deferred | **PARTLY STALE.** They are shipped for the swarm (S3). The *zone* model is what is still deferred. |
| `docs/feature-proposals.md:112-113` (FW-1) | "Worktree location… NOT inside the project working tree (user constraint 2026-05-30)" | **Conflicts** with S3 D1 (2026-07-28, signed off): `<project>/.canvas/worktrees/`. → O-1 decided for D1; WS-0 marks FW-1 superseded. |
| `docs/feature-proposals.md:106-108` | A zone can't be a clipping frame (ADR 0002 native view) | Stale premise. OSR boards clip now (`CLAUDE.md:56-60`). Still, there is no need for a clipping frame. |
| `boardSchema.ts:489-490` | "Named-empty groups survive" | **Contradicts** `reconcileGroups` ("reverses the old named-empty-survives rule", `:1148-1150`). [V] |
| `src/main/appModel.ts:73` | "Empty until PR-5 mirrors groups to MAIN" | Stale. Groups are mirrored (`boardRegistry.ts:794`). [V] |
| `docs/roadmap-mcp.md:377-381` (T6.1) | Worktree manager to build | It largely exists (swarm). M6 now means **generalize** it, not build it. |
| `boardSchema.ts:1305` (found 2026-11-03) | "keep named-empty groups" | Same contradiction as `:489-490`. [V] |

### 1.9 Re-check after I1, I2 and I3 merged (2026-11-03, `main` @ `0bdccf66`)

**State.**
- Merged: I1 #442 (v0.47.22), I2 #443 (v0.47.23), #444 (tidy engine lazy-loaded, v0.47.24), #445 (mcp pin 0.28.1, v0.47.25), I3 #446 (v0.47.26).
- The schema is **still v23 / floor 23** (`boardSchemaVersion.ts:117`, `:163`), so workspaces still take **v24**.
- My local `main` checkout is at the tip, and the research doc is still untracked.

**What the merges give workspaces** [V]:

| Need | Now on `main` | Effect on the plan |
|---|---|---|
| Focus = fit to screen (D-7) | `runTidy` accepts `scope: { boardIds }` (`tidyContract.ts:47`). For a partial scope it settles in place, anchored at the top-left; on collision it moves the whole arrangement to free space, and outside boards never move (`spatialTidy.ts:340-350`, `groupTidyPlace.ts:68`). It is **one** `applyLayout` (`:384`). `moved: 0` records no undo step (`:87`). It frames the camera unless `fit:false` (`:391-393`), and reports `fitZoom` / `readable` / `relocated` (`:84-100`). | **WS-5 needs no new engine.** `useWorkspaceFocus` calls the lazy entry `runTidyAndReport({ mode: 'fit', overflow: 'report', scope: { boardIds } })` (`useTidyTile.ts:41`). That is the same path as **Tidy group** (`:150-157`). It confirms D-7's "no undo when nothing moved". I did not re-verify which overflow mode is the default, so WS-5 passes `overflow: 'report'` explicitly (`tidyContract.ts:22`): boards are never shrunk silently. |
| Tidy a workspace from its menu | **Tidy group** row, wired to `tidyGroup` (`GroupContextMenu.tsx:37`, `Canvas.tsx:1006`) | WS-5's zone menu copies this row. |
| Agents and Jarvis tidy/focus by workspace | `tidy_canvas` validates `{ groupId }` against the group mirror (`mcpTidy.ts:39-41`). Jarvis `resolveGroupRef` is at `jarvisTools.ts:409`. | WS-6 (synthetic groups) is still the way to let agents say "tidy the API workspace". It stays a follow-up, because the user's own focus no longer needs it. |
| Group focus today | Still camera-only. `fitGroup` moved to `useGroupInteractions.ts:86-100`. | Unchanged: D-7 replaces it for workspaces. |

**Gaps that are still open after the merges** [V]:
- **Allocator:** `swarmWorktree.ts` is unchanged. It refuses polyrepo projects and hard-codes `HEAD` (`:244`).
- **Start folder:** `ptyShells.ts`, `pty.ts` and `terminalSpawnMath.ts` are unchanged (`resolveSpawnArgs` `:68`). `safeCwd` still falls back to `$HOME`.
- **`configure_board`:** a cwd-only change is still un-gated, "no exec vector" (`mcpOrchestrator.ts:527-528`, `:614-620`).
- **`spawn_board`:** checks only that `cwd` is used on a terminal (`mcpLifecycle.ts:252-258`). There is still no containment, and Jarvis `spawn_board` passes `cwd` straight through (`jarvisTools.ts:561-583`).
- **The `appModel.ts:73` comment** ("Empty until PR-5 mirrors groups") is still stale. So is the Jarvis "Workspace:" label, now at `jarvisPersona.ts:112`, `:164`.

**Line refs that moved:**

| Was | Now |
|---|---|
| `useGroupInteractions.ts:84-99` | `:86-100` |
| `useTidyTile.ts:109-140` | `tidyAndFit` `:118`; `tidyGroup` `:150` |
| `boardRegistry.ts:794-817` | `sanitizeGroups` `:809` |
| `mcpOrchestrator.ts:610-616` | `:614-620` |
| `mcpLifecycle.ts:291` | `:252-258` |
| `jarvisTools.ts:133-148` | focus `:131`, tidy `:144`, spawn `:184` / `:561` |
| `appModelDrift.test.ts:50` | `HOST_PENDING_TOOLS` is now an empty set |

---

## 2. Gap list: what blocks API/Uploader end to end

1. **G1 No workspace entity.** `NamedGroup` has no root/goal/git (`boardSchema.ts:494-498`). Its multi-membership contradicts D-3. MAIN never sees extra group fields (`boardRegistry.ts:813`).
2. **G2 cwd doesn't follow a workspace.** New terminals default to the project root (`terminalSpawnMath.ts:74`). A deleted or moved workspace dir silently launches the agent in `$HOME` (`ptyShells.ts:69-76`). That is the worst failure for confinement.
3. **G3 The allocator is project-rooted.**
   - It refuses a polyrepo project (`swarmWorktree.ts:197-206`).
   - Removal runs from the project dir, which breaks in a polyrepo (`:293`).
   - The branch scheme is run/worker-only (`:126-129`).
   - There is no "attach an existing branch" and no base-ref choice.
4. **G4 No lifecycle UI/IPC** for create/delete. The dirty-disposition UI exists only as the swarm triage row.
5. **G5 Uncontained cwd** on MCP `spawn_board`/`configure_board` (`mcpLifecycle.ts:291`, `mcpOrchestrator.ts:610-613`) and on Jarvis `spawn_board` (`jarvisTools.ts:142`).
6. **G6 No caller scope.** Authority today is tier + cable (+ dispatchGate). Nothing says "this agent belongs to API".
7. **G7 Agent config isn't confining.** The per-cwd `.mcp.json` separates API from Uploader already (`cliProvisioners/index.ts:323`), but nothing denies edits outside the root. codex/gemini config is machine-global (†).
8. **G8 No shared, human-authored context.** Memory is flat per project (`canvasMemory.ts:116-130`). `project.md` is an LLM rollup (`summaryLoop.ts:733`). There is no per-workspace brief the user owns and agents read live (D-6).
9. **G9 No in-canvas switcher** (D-5). There are the group focus picker and the project switcher, but nothing for workspaces.
10. ~~**G10 Spatial scope isn't on main yet.**~~ **Closed 2026-11-03.** I2 and I3 merged: scoped tidy, including `{ boardIds }`, now works (§1.9).
11. **G11 The swarm ignores workspaces.** A swarm run inside the API workspace would allocate from the *project* repo, not API's repo (`swarmWorktree.ts:187-206`).
12. **G12 Provisioned files dirty worktrees [I].**
    - `.mcp.json` and `.claude/settings.local.json` written into a worktree are untracked.
    - `status` counts untracked entries (`swarmWorktree.ts:148-151`), so a clean worktree reads as dirty.
    - The delete flow then prompts every time.
    - I didn't trace whether swarm workers hit this today.
13. **G13 Previews: ports, not structure.** `previewSourceId` already scopes a preview to its terminal. But two worktrees of one repo default to the **same dev port**. Expanse detects the port and doesn't assign one (`CLAUDE.md:106`), so the second server must choose another port. This is UX copy, not new machinery.
14. **G14 No dependencies in a fresh worktree.** S3 shipped "no node_modules link" (`s3-design-artifact.html`, variant C). A new worktree can't run its dev server until something installs.

---

## 3. Design options

### Option A: a workspace is an extended `NamedGroup`
Add `workspace?: {root, goal, git?}` to `NamedGroup`.
- **Schema.** The field rides through older readers (`reconcileGroups` spreads `...g`, `:1157`), so it is technically writer-only.
  - The *semantics* break under an older reader, though:
    - Zero-member groups are dropped on load (`:1158`), so an empty workspace vanishes and its worktree is orphaned.
    - An older reader lets a board join two workspace-groups, which violates D-3.
    - "Remove group" deletes a workspace with no dirty prompt.
  - Policy therefore forces **floor 24 anyway**.
  - MAIN's `sanitizeGroups` must also widen (`boardRegistry.ts:813`).
- **cwd/worktree.** Resolving a board's workspace means scanning groups. Multi-membership makes the answer ambiguous unless a new cross-group invariant is enforced everywhere groups are written: the store, I1's `edit_groups`, and Jarvis.
- **MCP.** Layout tooling works for free, since a workspace *is* a group. But I1's `group_boards`/`edit_groups` can rename, ungroup or re-member a workspace through a batch-confirm that knows nothing about worktrees, so `mcpGroups.ts` needs special cases.
- **Migration.** Existing groups promote in place. That is nice.
- **UX.** "Group" (navigation) and "workspace" (isolation + lifecycle) collapse into one thing. "Ungroup" becomes "destroy workspace?".

### Option B (**recommended**): a doc-level `workspaces[]` entity + `board.workspaceId`, projected as a group for spatial tooling
- **Schema.** New root key `workspaces` plus an optional per-board `workspaceId`: **v24, floor 24** (ADR 0007 `:55`). One bump.
  - The 0..1 membership of D-3 holds **by construction**, because it is a field on the board.
  - Empty workspaces survive.
  - Older apps refuse the doc rather than corrupting it.
- **cwd/worktree.** `board.workspaceId → workspace.effectiveRoot` is a lookup. MAIN mirrors workspaces (a new sanitizer) and is the authority.
- **MCP.**
  - **v1 needs zero package changes.** MAIN projects each workspace as a *synthetic, read-only group* (same id) in `listGroups()`/`canvas://contexts`.
    - `tidy_canvas scope:{groupId}`, `focus_viewport groupId` and Jarvis `focus_viewport group` then work on workspaces, because `spatialIdSchema` accepts any id (`spatialShared.ts:37`).
    - `edit_groups`/`group_boards` on a workspace id are refused.
  - The richer surfaces (resources, a spawn param) come in P2 as one publish + pin bump.
- **Migration.** None is required: no `workspaces` means today's behaviour. Two assists:
  - "Make workspace from group" (Option A's one advantage, as a one-shot action).
  - "Suggest workspaces" from `deriveContexts` cwd clusters (`:15`, `:22`).
- **UX.** Two clean concepts: a workspace is isolation + lifecycle + brief; a group is free-form navigation. Zone visuals reuse the group layer's look.

### Option C: one canvas per workspace (`.canvas/workspaces/<id>/canvas.json`)
- **Rejected by D-2** (one shared canvas), recorded for completeness.
- **Schema/layout.** Changes ADR 0009, the project open/switch pipeline and background sessions (ADR 0011). Cross-workspace cables and a shared plan become impossible.
- **MCP.** Board routing becomes per canvas, which touches `mcpBoardProjects` and token routing everywhere.
- **Migration.** Splits existing canvases.
- **UX.** Strong isolation, but a switch reloads the whole canvas.

### Comparison

| | A · extended group | **B · workspace entity** | C · canvas per workspace |
|---|---|---|---|
| Schema (ADR 0007) | floor 24 forced by semantics; MAIN mirror widened | **v24 / floor 24, one clean bump** | new file layout; ADR 0009 change |
| 0..1 membership (D-3) | needs a new invariant across all group writers | **by construction** | by construction |
| cwd + worktree lifecycle | ambiguous lookup; I1 ops can break a workspace | **direct lookup; lifecycle owned by one IPC** | per-canvas, simple |
| MCP / package | none for layout; special cases in I1 | **none for v1 (projection); one publish for P2** | large (routing) |
| Migration | promote groups in place | **none required; two assists** | split canvases |
| UX | conflates group with workspace | **two clear concepts; zone reuses group visuals** | reload on switch; violates D-2 |
| Reuses I1/I2/I3 | fully | **fully, via projection** | barely |

**Persistence variant (O-2, decided: in `canvas.json`, not the sidecar).** Option B could store `workspaces[]` in a sidecar
`.canvas/workspaces.json` instead of `canvas.json`. That needs **no floor bump**, because older apps ignore the
file and older readers keep unknown optional board fields. The costs:
- two-file consistency;
- an undo rail that spans files;
- an older app silently running workspace terminals at the project root, with no confinement.

I recommend in-doc with floor 24. The floor has moved with nearly every recent bump (it is 23 = writer 23).

---

## 4. Recommended design (Option B)

### 4.1 Data model

```ts
// canvas.json root — schema v24, minReaderVersion 24 (doc-level key ⇒ floor, ADR 0007 :55)
interface CanvasDoc {
  /* … */
  workspaces?: Workspace[]                   // absent ⇒ [] (migration 23→24)
  /** O-10: the base branch remembered per repo, keyed by project-relative repo root ('api', '.').
   *  Written the first time the user picks a base for that repo; pre-fills the next New Workspace. */
  repoDefaults?: Record<string, { base: string }>
}

interface Workspace {
  id: string                 // uuid, MAIN-minted
  name: string               // sanitizeGroupName (I1-hardened), unique per project (case-insensitive)
  goal: string               // one line, ≤ 200, control-char-free
  color: WorkspaceColor      // fixed token set (zone tint + chip); not free hex
  /** The folder this workspace is ABOUT. Project-relative POSIX ('api', 'uploader', 'packages/web').
   *  Must resolve INSIDE the project dir (v1). '.' allowed (whole project, e.g. same-repo branches). */
  root: string
  /** Present iff Expanse allocated (or attached) worktrees for this workspace.
   *  A LIST so multi-repo workspaces (O-10, later) need no second format change.
   *  v1: validation rejects length > 1. */
  worktrees?: WorkspaceWorktree[]
  state?: 'archived'         // record kept after "keep worktree on disk" delete (§4.3)
  keepLayout?: boolean       // D-7 opt-out: focus is camera-only ("Keep my arrangement")
}

interface WorkspaceWorktree {
  repoRoot: string           // project-relative: repo that owns the worktree ('api' or '.')
  worktree: string           // project-relative: '.canvas/worktrees/<slug>'
  branch: string             // 'ws/<slug>' (new) or the attached branch
  baseRef: string            // branch the user picked ('release'); shown in the status
  base: string               // commit sha at creation (future diff/merge views)
}

interface BoardCommon { /* … */ workspaceId?: string }    // absent ⇒ project-level (D-3)
```

- **Effective root** (v1, at most one worktree `w`) = `w ? join(w.worktree, relative(w.repoRoot, root)) : root`.
  - The relative part handles a monorepo subfolder: project = repo, root `packages/api`, worktree of the project repo, effective root `<wt>/packages/api`.
  - For polyrepo `api`: repoRoot `api`, effective root = the worktree itself.
  - **Later, multi-repo:** each repo's worktree goes to `.canvas/worktrees/<ws>/<repo>`, and the effective root becomes `.canvas/worktrees/<ws>/`, so terminals there see every chosen repo. This is not in v1; the list shape only keeps the door open.
- **`repoDefaults`** rides the same v24 bump (it is a doc-level key, so it would raise the floor on its own; adding it in the same version costs nothing). It is in `canvas.json`, so when `canvas.json` is committed a team shares "api branches off `release`". A remembered base that no longer exists falls back to the repo's `HEAD`, and the dialog says so.
- **Paths are stored project-relative**, so `canvas.json` stays portable. MAIN resolves them against the project dir, then realpaths them.
- **Reconcile:**
  - Clear a dangling `workspaceId` (the board becomes project-level).
  - Keep zero-board workspaces.
  - Drop a workspace whose `root` escapes the project, and toast it.
  - A docked swarm worker inherits its swarm board's `workspaceId`.
- **Undo:**
  - Workspace **create/delete are not on the undo rail**. They have irreversible side effects (worktree add/remove), so they are settings-class like the backdrop (`CLAUDE.md:115`).
  - **Assigning or unassigning a board** is a normal undoable patch.
- **Machine-local view state** lives in `.canvas/session.json` (`projectStore.ts:32`): `activeWorkspaceId`, `workspaceView: 'all' | 'dim' | 'solo'`.
- **Context files** live outside `canvas.json` (§4.5): `.canvas/workspaces/<id>/CONTEXT.md` and `.canvas/workspaces/_project/CONTEXT.md`.
- **Groups are unchanged.** A group may span workspaces. Fix the stale `:489-490` comment.

### 4.2 How a board resolves its cwd

The renderer proposes and **MAIN decides**.

1. **Renderer** (`resolveSpawnArgs`, `terminalSpawnMath.ts:64-77`):
   - Workspace board: `cwd = board.cwd ?? workspace.effectiveRoot`.
   - Project-level board: unchanged, `board.cwd ?? projectDir`.
   - It sends `{cwd, workspaceId}` on `pty:spawn`.
2. **MAIN** (`pty.ts:771`):
   - For a board with a `workspaceId`, look the workspace up in **MAIN's own mirror**. Never trust the root the renderer sends.
   - `realpath` both, then require `isWithin(effectiveRoot, cwd)` (export `pathSafe.ts:41`).
   - Use a new **`strictCwd`**: a missing dir, a non-dir or an escape → `spawn-failed` with a sentence. Example: *"Workspace "API" folder is missing (api/). Restore it or remove the workspace."* **Never `$HOME`.**
   - Project-level boards keep `safeCwd`, so their behaviour is unchanged.
3. **Env** (`ptySpawnEnv.ts`): add `CANVAS_WORKSPACE_ID`, `CANVAS_WORKSPACE_ROOT` and `CANVAS_WORKSPACE_CONTEXT` (absolute path to the brief). These are cheap hooks for recap and agents.
4. **Existing per-cwd consumers scope for free:** `boardCwds` / gitDiff (`pty.ts:824`†), port detection and the provisioner (`cliProvisioners/index.ts:323`).

### 4.3 Worktree create and delete flow

There is **one allocator**: `swarmWorktree.ts`, generalized and not forked.

- `allocate({repoDir, slug, branch, base?, attach?})` replaces `allocate(runId, workerName)`.
  - The swarm call site passes `branchFor(runId, slug)`, so its behaviour is identical.
  - `repoDir` must sit inside the project. The git probe runs **on `repoDir`, not the project** (fixes G3 polyrepo).
- `removeIfClean`/`dispose` run git **from the worktree's owning repo** (`git -C <repoRoot>`), never from inside the worktree. That keeps the Windows cwd-lock rule (`:286-289`) and fixes G3 removal.
- `owns()` keeps the `.canvas/worktrees/` containment root, which is shared by swarm and workspaces. The slug namespace is `ws-<slug>` vs worker slugs.
- Before any `status`, **unsync Expanse-provisioned files in that dir** (we wrote them, so we remove them), so they don't read as dirt (G12).

**Create** (`workspace:create`, frame-guarded IPC → MAIN):
1. Dialog fields:
   - Name, Goal, Color.
   - **Folder**: a picker rooted at the project; outside the project is refused in v1 (O-7).
     - **Polyrepo projects (O-10):** above the picker, the dialog lists every git repo MAIN finds in the project. It scans the project root and one level down, and skips `.canvas/`, `node_modules/` and dot-folders. Picking a repo fills the folder.
   - Git mode: **Use folder as-is** (default) · **New worktree + branch** · **Attach existing branch**.
   - **Base branch** (new-worktree mode, O-10): a dropdown of that repo's local and remote-tracking branches, listed by `simple-git` in MAIN.
     - **First time for a repo:** no default is remembered. The dropdown pre-selects the repo's current branch, and the dialog asks the user to confirm it. **Remember for this repo** is ticked.
     - **After that:** pre-filled from `repoDefaults[repoRoot]`, marked "remembered". Changing it updates the memory while the box stays ticked.
     - Expanse never fetches on its own. If the user wants a fresher `origin/release`, they fetch first.
   - **Ask the agent to install dependencies** (worktree modes only, O-9; ticked by default, as in the approved mock): see step 5.
   - Starter boards: Terminal (launch command) · Browser · Brief.
2. MAIN probes the folder with `repoScopedGit(folder).checkIsRepo()` + `--show-toplevel`.
   - **Not a repo:** the git modes are disabled with *"Not a git repository — Expanse never runs `git init`."* (locked rule).
   - Folder-as-is workspaces need no git at all.
3. Allocate (worktree modes) → stat-prove the dir (the S3 guard) → only then write the record.
   - Branch `ws/<slug>` off the chosen base, collision-suffixed. Attach mode = `git worktree add <path> <branch>`; git itself refuses a branch already checked out elsewhere.
   - The allocator hard-codes `HEAD` as the base (`swarmWorktree.ts:240-244`, §1.4). WS-1 adds a `base` parameter that defaults to `HEAD`, so the swarm is unchanged and a workspace can branch off `release`.
4. Scaffold `CONTEXT.md` (§4.5). Place the starter boards in free space as one contiguous zone (I3's `groupTidyPlace` / `freeSlot`).
5. **Dependencies (O-9).** If the box is ticked, once the starter terminal's agent is up, Expanse sends it one fixed prompt:
   - *"This is a fresh git worktree, so its dependencies are not installed. Install them first. Read the lockfiles and manifests to pick the tool (pnpm, npm, pip, poetry, cargo, …), then report what you ran."*
   - Expanse never runs an install command itself.
   - The user's tick is the consent, so there is no second confirm.
   - The delivery path is [I]: reuse whatever the swarm uses to hand a worker its first brief (`rolePacks.ts` per-dispatch brief). WS-4 verifies this before building.

**Delete** (`workspace:delete`):
1. Ask what happens to the boards: **Keep (they become project-level)** (default) or **Close them**. Closing kills agents and needs a confirm.
2. Running terminals whose cwd is inside the worktree must stop first. Windows refuses to remove a dir that is any process's cwd (`swarmWorktree.ts:286-289`). Prompt and kill.
3. Folder-as-is → remove the record. Expanse never touches the folder.
4. Worktree → `status`:
   - **Clean:** `git worktree remove` (no force).
   - **Dirty: keep on disk + prompt** with Commit / Stash / Discard (second confirm) / Keep. This reuses `dispose()` and the swarm triage row UI.
   - **Keep** → the record becomes `state:'archived'` (it shows "Re-open" / "Remove when clean"), so a kept worktree is never orphaned under `.canvas/worktrees/`.
   - The branch is **always kept**.
5. On project open, reconcile git-backed workspaces. A missing worktree dir → chip shows "missing" and spawns are refused (via `strictCwd`). No automatic `git worktree prune`.

### 4.4 Confining agents to their workspace (D-4: what Expanse owns)

**Caller scope.**
- MCP caller: token-derived board id (`mcp.ts:363-365`) → MAIN mirror `board.workspaceId` → scope **W** (a workspace) or **PROJECT** (no workspace).
- Jarvis: always PROJECT, and every write is already human-confirmed.

The new module is `src/main/workspaceScope.ts`: `callerScope(boardId)`, `assertCwdInScope(scope, cwd)`, `assertTargetInScope(scope, targetBoardId)`.

| Surface | Today | Rule |
|---|---|---|
| `spawn_board` | cwd trimmed only (`mcpLifecycle.ts:291`) | **W caller:** the new board gets `workspaceId = W`; cwd (optional) must realpath inside `W.effectiveRoot`, else `invalid_input` with a sentence. **PROJECT caller:** a cwd inside some workspace's root joins that workspace (derived); otherwise project-level; **a cwd outside the project dir is refused** (new). |
| `configure_board` cwd | un-gated (`mcpOrchestrator.ts:610-613`) | The target must be in the caller's scope. The new cwd must stay inside the **target's** workspace root. Moving a board between workspaces is a human UI action only. |
| relay / handoff / assign | cable + dispatchGate | W → a terminal in another workspace: **refused**. PROJECT ↔ any: allowed, with the existing confirm. |
| planning / card / close writes | confirm-gated | W → boards in W or project-level boards (shared kanban): allowed. W → another workspace's boards: **refused**. |
| tidy / focus | viewport only | Allowed. A W caller's default `scope` is W. |
| Jarvis `spawn_board` | cwd uncontained (`jarvisTools.ts:142`) | Same containment as PROJECT. With a workspace active, the default cwd is the active workspace's root. |
| `.mcp.json` / settings | per cwd, last writer wins | Already separated per workspace root by construction. **Add** Claude Code `permissions.deny` entries to `<effectiveRoot>/.claude/settings.local.json`: `Edit(//<abs>/**)` for every *other* workspace root, sibling worktrees, `.canvas/canvas.json` and `.canvas/workspaces/**`. These are merge-preserving and swept on revoke through `provisionedDirStore`. |
| codex / gemini | machine-global config (†) | Cannot be scoped per workspace. **Documented limitation.** Their token is the last spawned board's, across workspaces. |
| board listing / summaries | tier-scoped in the package (†) | P2 (package): a W caller sees W + project-level boards. |
| PTY env | `CANVAS_RECAP_BOARD` | Add the `CANVAS_WORKSPACE_*` vars (§4.2). |

**State plainly in the docs:** none of this stops a shell agent running `cd ../uploader && …`.
- Claude Code `deny` rules govern its Edit tool, **not Bash redirects** [DOC].
- Its filesystem sandbox (which defaults writes to the cwd) **doesn't exist on native Windows** [DOC].
- On macOS/Linux/WSL2 the provisioner **also sets `sandbox.enabled`** in the same file (O-5). It merges the key the same way as the deny rules, keeps the user's own settings, and removes the key again on revoke.

### 4.5 Shared context (D-6)

**Shape (O-6): live status + my notes, one file per workspace, inside `.canvas/`.** The top half is a read-only view
of the workspace that Expanse keeps current: the goal, what is in progress, what the agents are doing, recent
results. The bottom half is the user's notes. Agents read both and write neither.

| File | Status half (Expanse writes) | Notes half (the user writes) | Who reads it |
|---|---|---|---|
| `.canvas/workspaces/<id>/CONTEXT.md` | this workspace's live status | anything: decisions, rules ("don't touch /uploader"), links | user + that workspace's agents + project-level agents |
| `.canvas/workspaces/_project/CONTEXT.md` | one line per workspace: name, goal, branch, tasks in progress, busy agents | project-wide notes | user + every agent in the project |

Example, as approved:

```md
<!-- expanse:status:start — Expanse rewrites this part; edit below the line -->
# API — build auth
_Live status, updated by Expanse 14:02_

Goal: build auth (JWT + refresh)
Branch: ws/api off release · 3 files changed

## In progress
- [ ] Refresh-token rotation   (Kanban: In Progress)
- [x] Login endpoint           (checklist)

## Agents
- claude #1  busy  "writing token tests"
- codex  #2  idle

## Recent results
- 13:40 login endpoint done, 12 tests pass
<!-- expanse:status:end -->

---
## My notes   (yours, edit anytime)
Use argon2, not bcrypt.
Don't touch /uploader.
```

**Where each status line comes from.** All of it is deterministic: no LLM, no network. So, unlike `project.md`
(`summaryLoop.ts:733`), it needs no consent gate.

| Line | Source | Tag |
|---|---|---|
| Goal, branch, base | the `Workspace` record (§4.1) | design |
| Files changed | allocator `status` on the worktree, after the provisioned-file unsync (§4.3); only for git-backed folders | [I] |
| In progress | Kanban cards on the workspace's boards that are not in the last column (default columns Backlog / In Progress / Review / Done, `kanbanSchema.ts:122-127`), plus open checklist items (`ChecklistItem.done`, `boardSchema.ts:302-305`) | [V] |
| Agents | the workspace's terminal boards. For Claude: recap facts `status` / `live` / `title` / `lastAsk` / `todos` (`recapFacts.ts:65-98`). Other CLIs show only running / exited. | [V] Claude; [I] others |
| Recent results | `recordBoardResult` (`boardResults.ts:64`), the one choke point for both `write_result` and the synthesized result. The store is an in-memory Map (`:14`), so the file keeps the last 5 lines and they survive a restart. | [V] |

**Writing it safely.** MAIN's new `workspaceStatus.ts` owns the status half:
- **When:** on board-mirror changes, results and recap updates, debounced to at most once per 5 s per workspace. It skips the write when the text hasn't changed, so the file never churns.
- **Only between the markers.** It re-reads the file just before writing, swaps the status block, keeps every byte below it, and writes atomically (`write-file-atomic`).
- **Before the rename** it checks that the file's mtime hasn't changed since that read; if it has, it starts over.
- **Paused while the Brief board has unsaved edits.** File boards are editable unless `readOnly` (`boardSchema.ts:240-241`).
- **Missing or broken markers** (the user deleted them): Expanse puts a fresh status block at the top and treats everything else as notes. It never drops user text.
- A tiny race window remains, between the mtime check and the rename, if an external editor saves at that exact moment. That is accepted and documented.

**The rest:**
- **Git:** ignored by default (private body `*`, `canvasMemory.ts:32`). With commit opt-in it is tracked (`workspaces/` isn't in the committed ignore list, `:39`), so a team can share notes.
- **Where the user reads it:**
  - A **Brief** board, a File board bound to the file (`boardSchema.ts:230-243`, read live from disk), placed at the zone's top-left.
  - The workspace chip menu → "Open context".
- **Agents read it live:**
  - **v1 (no package change):** `CANVAS_WORKSPACE_CONTEXT` env + the provisioned launch hint.
  - **P2:** MCP resource `canvas://workspace/context`. It is caller-scoped, returns project file + own file, and is read from disk on every call.
  - Never written into the user's repo (no `CLAUDE.md` injection).
- **Agents never write it.** They get a `deny` on `.canvas/workspaces/**` (§4.4). When they want something recorded, their `write_result` shows up under Recent results.
- **Notify agents** (optional, for note edits): sends one fixed line ("Workspace context updated, re-read it") to the workspace's running terminals through `dispatchGate` (human-confirmed). Status refreshes never notify.
- `digest.md` is dropped; the live status replaces it.

### 4.6 UI (create, switch, focus, filter)

- **Workspace chip** in `AppChrome`, next to the project name:
  - It shows the color dot + active workspace name, or **All**.
  - Click opens a list. Each row: name, goal line, branch, a running-agents/attention dot and a dirty count. Number keys **1–9** jump; **New workspace…** and **Open context** are at the bottom.
- **Hotkey:** a rebindable, MAIN-bound accelerator that cycles with commit-on-release, cloned from `RunningProjectSwitcher` (`:2-13`).
- **Switch =** one instant step, with no reload and no PTY parking:
  1. set `activeWorkspaceId` (in `session.json`);
  2. **fit the workspace to the screen** (next bullet);
  3. apply the view filter;
  4. new boards from the dock default into the workspace, with cwd = its root;
  5. Jarvis gets the active workspace and its brief.

  This differs from the project switch, which parks sessions. All workspaces keep running.
- **Focus = fit to screen (D-7).** Every way of focusing a workspace (chip, number key, hotkey, the `f` picker, a double-click on the zone tab, Jarvis `switch_workspace`) works like Tidy, for that workspace only. Today's group focus only moves the camera (`useGroupInteractions.ts:86-100` @ `0bdccf66`); this repacks first, the way `tidyAndFit` does (`useTidyTile.ts:118`). Since I3 merged, the engine call already exists: `runTidyAndReport({ mode: 'fit', overflow: 'report', scope: { boardIds } })` (§1.9).
  1. **Repack** the workspace's boards toward the canvas pane's aspect with the fit layout (`lib/fitLayout.ts:1-21`, wired by I2).
  2. **Place** it by I3's group-tidy rule: anchor at the zone's current top-left. If the new footprint would overlap any board outside the workspace, move the whole workspace to the nearest clear slot. **Boards outside the workspace never move.**
  3. **Frame** it with the existing fit (`FIT_FRAME`: 64px padding, max zoom 2×, `lib/canvasView.ts:38`). The workspace fills the canvas area: the window minus the top bar and dock.
  4. **Focusing the next workspace** runs the same steps for it. The one you left keeps its new arrangement.

  Rules:
  - **One undo step, and none when nothing moved.** The fit is deterministic, so re-focusing an untouched workspace at the same window size is only a camera move.
  - **A window resize re-fits the focused workspace.** It is rAF-coalesced and kept off the undo rail, following the tile-preset precedent (`useTidyTile.ts:126-140`).
  - **Too many boards to read** (fit zoom < 0.4, `spatialGeometry.ts:23`): I2's default `report` applies. Boards keep a readable size, and one toast offers Solo or pages. They are never shrunk without asking.
  - **Keep my arrangement** (`keepLayout`, a per-workspace setting): focus becomes camera-only, today's `fitGroup` behaviour, for a layout arranged by hand. Default off (O-12).
  - **A small workspace** stops at the 2× zoom cap. Boards are repacked, never enlarged, so a 1–2 board workspace may not fill edge to edge.
  - **Agent-driven focus stays camera-only.** MCP `focus_viewport` is viewport-only and un-gated (`mcpTypes.ts:375-377`). Rearranging on an agent's behalf goes through `tidy_canvas` and its D1 confirm.
- **Filter:**
  - **All** (no dimming).
  - **Dim others** (default while a workspace is active).
  - **Solo**: other workspaces' boards are hidden from render while their PTYs stay live. OSR liveness already paint-gates hidden browsers (`CLAUDE.md:65-67`).
- **Zone:**
  - A tinted outline + tab in the group-box visual language, with name, branch and status. Dragging the tab moves the whole workspace.
  - The context menu has **Tidy workspace** (I3) · Focus · Open context · Settings · Delete.
  - The `f` focus picker lists workspaces first.
- **Board chrome:** a workspace color pip on the title bar. The terminal header shows the branch.
- **Create:** the chip menu, the dock, "Make workspace from group" on the group menu, and "Suggest workspaces" (deriveContexts cwd clusters → I1 `BatchConfirmModal`, one row per proposal).
- Per `CLAUDE.md` › *Design artifact before code*, WS-4 and WS-5 each need a signed-off design artifact first.

### 4.7 Jarvis and MCP touchpoints

**Jarvis** (`jarvisTools.ts`, `jarvisManifest.ts`, `jarvisPersona.ts`):
- `list_boards` adds `workspaces`.
- New **`switch_workspace(name)`**: READ tier, auto-allowed (the I2 precedent: Jarvis `tidy_canvas` is READ and moves boards). It runs the same fit-to-screen focus as the chip (D-7).
- `spawn_board` gains `workspace` (name or id). MAIN resolves and contains the cwd.
- `focus_viewport group` resolves workspace names (through the projection).
- The manifest tags `ws:Name`.
- The system prompt injects the active workspace's brief.
- **Rename the `Workspace:` manifest header to `Canvas:`** (`jarvisPersona.ts:132`) to end the name clash.

**MCP v1 (no publish):**
- Synthetic-group projection: `listGroups`, `canvas://contexts`, `tidy_canvas scope:{groupId}` and `focus_viewport groupId` all work with a workspace id.
- Refuse `edit_groups`/`group_boards` on workspace ids: *"workspace membership is changed in the app"*.
- Confinement errors are returned as tool errors, so no wire change is needed.

**MCP P2 (one publish + pin bump):**
- `canvas://workspaces`;
- `canvas://workspace/context`;
- an optional `workspace` param on `spawn_board`;
- caller-scoped `canvas://boards`.

The package repo is already at 0.28.0, ahead of the 0.27.1 pin. Coordinate so 0.28.0 + P2 ship as one publish.

### 4.8 Naming

| Term | Means | Notes |
|---|---|---|
| **Workspace** (user-facing) | Isolation unit: root (+ optional worktree/branch), goal, brief, member boards | The "Feature Workspaces" epic name; drop "Feature" since a workspace can be any folder. |
| **Zone** | The *on-canvas region* of a workspace (outline + tab). Visual only, never a data entity. | FW-1/M6 used "feature zone" for the whole concept; that sense is retired. Keep "zone" out of product copy where possible: `ACTIVE-WORK.md` uses "zone" for dev file-ownership. |
| **Group** | Free-form, multi-member named cluster for navigation/layout | Unchanged. A workspace is *projected* as a read-only group for tooling, but isn't one. |
| **Context** (`canvas://contexts`) | Derived "which boards belong together" | Workspaces become authoritative inputs (like groups, rule 2). |
| **Brief** / CONTEXT.md | A workspace's (or `_project`'s) shared context: Expanse's live status + the user's notes | Distinct from `memory/project.md` (an LLM rollup). |
| **Project-level** | A board with no workspace | Its cwd is the project root, as today. |

### 4.9 A format change forces an update (O-2)

**The problem.** v24 raises the floor, so an older app refuses a v24 project. It throws "saved by a newer version of
the app; update the app to open it" (`boardSchema.ts:820-830`). The user wants older apps **forced to update** when
this happens, on both the production feed and the local feed.

**What exists** [V]:
- The production feed already has a force switch. In `build/updates.json`, `minSupported` is the floor (`"0.9.0"` today). `scripts/gen-updates-json.mjs:8-10` publishes it.
- An app below the floor gets the `mandatory` tier, which is a blocking modal (`autoUpdate.ts:29-33`; renderer `UpdateSurfaces.tsx:63`).
- If fetching the tier file fails, the app **fails open**: it never forces (`autoUpdate.ts:34-35`).
- The local feed reads the tier file from the same feed URL (`autoUpdateWiring.ts:95`).
- Today `release-local.mjs:153` writes it with **no floor, ever**: "a personal build must never force-block". The user's answer reverses this, for format changes only.

**Design:**
1. **Detect a format change at release time.** Both release scripts read `MIN_READER_VERSION` (`boardSchemaVersion.ts:163`) and compare it with the `minReaderVersion` that the **previous** feed's `updates.json` recorded. That is a new field, which both scripts start writing.
2. **If the floor went up**, the release sets `minSupported` to its own version, so every older app gets the blocking update modal.
   - `release.mjs` does this through `gen-updates-json.mjs`.
   - `release-local.mjs` writes it into the local `updates.json`, replacing the "never a floor" line for this one case. An ordinary local release still never forces.
   - If the floor did not go up, nothing changes: the tier rules stay as they are.
3. **The refusal message gets an Update now button.** Wherever the "newer version" open error is shown [I: the open-failure surface; WS-12 finds it], add a button that runs the existing `update:check` → `update:download` → `update:install` steps.
   - This covers an old app that has not checked the feed since the release.
   - It also covers fail-open: offline, the app can't force, but the button retries.

**Limits, stated plainly:**
- The force is per app, not per project. Once a format-changing release is out, every older install must update, even one that never opens a workspace project. The user chose this.
- Apps released **before** this slice still honour `minSupported`, so step 2 reaches them. Step 3 helps only apps released after it.
- A dev build (`pnpm dev`) never auto-updates. The ESCHEMAFLOOR guard (`projectStore.ts:229`) still stops it from raising a real project's floor.

---

## 5. Slice plan

Versions: `main` is at 0.47.26 (I3). WS slices start from 0.47.27; re-derive at every rebase. A
schema bump has taken a minor version before (#365 → v0.24.0), so WS-2 = **0.48.0**.

| Slice | What | Files (primary) | Schema | Tests | Depends on |
|---|---|---|---|---|---|
| **WS-0** | ADR 0014 "Project workspaces" (D-1…D-7 + the O-1…O-12 answers, naming; FW-1 `:112` superseded per O-1). Fix §1.8 stale docs and comments. | `docs/decisions/0014-*.md`, `CLAUDE.md` Git/worktrees, `docs/feature-proposals.md`, `docs/roadmap*.md`, `boardSchema.ts:489` comment, `appModel.ts:73` comment | none | — | — |
| **WS-1** | Generalize the allocator: `repoDir` probe, owning-repo remove, branch/slug params, attach mode, **`base` param (default `HEAD`, O-10)**, unsync-before-status. Add `listRepos(projectDir)` (root + one level, skips `.canvas`/`node_modules`/dot-dirs) and `listBranches(repoDir)` (local + remote-tracking, no fetch). Swarm behaviour identical. | `src/main/swarmWorktree.ts` (+test), `swarmTools.ts` (call site), `swarmChatIpc.ts` (seam) | none | unit: polyrepo `repoDir`; remove-from-owning-repo; attach; base = named branch; `listRepos` skips; swarm parity (`HEAD`). e2e: real temp **polyrepo under a spaced path**, create off a non-HEAD branch → `git worktree list` → dirty keep → clean remove | I2 + I3 merged (O-11) ✓ met |
| **WS-2** | Data model: `workspaces[]` (with `worktrees[]`, v1 ≤ 1), `repoDefaults`, `board.workspaceId`, migration 23→24, reconcile, `workspaceSlice`, MAIN mirror `sanitizeWorkspaces` (bounded like `sanitizePorts`) | `boardSchema.ts`, `boardSchemaVersion.ts`, `store/slices/workspaceSlice.ts` (new), `canvasStore.ts` (wire), `boardRegistry.ts`, `mcpRegistry.ts` types | **v24 / floor 24** | unit: migration golden; round-trip; dangling id cleared; empty workspace kept; escaping root dropped; `worktrees` length > 1 rejected; `repoDefaults` round-trip; create/delete off the undo rail, assign undoable. e2e: persistence round-trip | I2 + I3 merged (O-11) ✓ met; **WS-12 released first** |
| **WS-3** | Spawn path: renderer resolution, MAIN authority, `strictCwd`, `CANVAS_WORKSPACE_*` env, scoped New Terminal dialog | `terminalSpawnMath.ts`, `useTerminalSpawn.ts`, `NewTerminalDialog.tsx`, `pty.ts`, `ptyShells.ts`, `ptySpawnEnv.ts`, `preload/index.ts` (+`.d.ts`) | none | unit: `resolveSpawnArgs` matrix; `strictCwd`; MAIN refuses a forged root. e2e: workspace terminal `pwd` = root; deleted root ⇒ visible spawn error, **not `$HOME`** | WS-2 |
| **WS-4** | Lifecycle: `workspace:create/delete/status` IPC, MAIN `workspaceStore`, create/delete dialogs reusing the swarm disposition row, archived state, open-time reconcile. **Create dialog (O-9, O-10):** polyrepo repo list, base-branch dropdown + "Remember for this repo" (`repoDefaults`), "Ask the agent to install dependencies" (one fixed prompt) | `src/main/workspaceIpc.ts`, `src/main/workspaceStore.ts` (new), renderer `NewWorkspaceDialog.tsx`, `DeleteWorkspaceDialog.tsx`, `preload/index.ts` | none | unit + e2e: folder workspace; worktree workspace off a remembered base; first-time base asked, second time pre-filled; missing remembered base ⇒ `HEAD` + notice; non-repo ⇒ git modes disabled (never init); deps box ⇒ exactly one prompt, no install command run by Expanse; dirty delete ⇒ prompt ⇒ keep ⇒ archived; clean delete removes, branch survives; delete keeps boards as project-level (O-8) | WS-1, WS-2; **design artifact** |
| **WS-5** | Zones + chip + switcher + hotkey + **focus = fit to screen** (D-7: fit layout + I3 placement + frame), live re-fit on resize, Keep-my-arrangement setting, All/Dim/Solo, dock default, `session.json` active id | `WorkspaceZoneLayer.tsx` (new; shares GroupBoxLayer drawing), `AppChrome.tsx`, `WorkspaceSwitcher.tsx` (new), `useWorkspaceFocus.ts` (new; calls `runTidyAndReport({ mode: 'fit', overflow: 'report', scope: { boardIds } })`, `useTidyTile.ts:41`, so the engine is reused as-is, §1.9), hotkey hook + MAIN accelerator, `projectStore.ts` (session sidecar) | none (`keepLayout` rides v24) | unit: switcher store (cycle/commit/cancel); focus = fit, then frame; no undo entry when nothing moved; `keepLayout` ⇒ camera only. e2e: focus fills the pane at two window sizes (different arrangements, both readable ≥ 0.4); boards outside the workspace unmoved; focus next ⇒ previous keeps its layout; new terminal lands in the active workspace; hotkey cycle | WS-2, WS-4 (menu entry), I2 + I3 ✓ merged; **design artifact** |
| **WS-6** | Spatial projection: workspaces as read-only synthetic groups in `listGroups`/contexts; `resolveScope` maps them; `edit_groups` refuses them; Jarvis `resolveGroupRef` | `boardRegistry.ts`/`mcpRegistry.ts` (listGroups), `store/spatialTidy.ts`, `src/main/mcpGroups.ts`, `src/shared/deriveContexts.ts` input, `jarvisTools.ts` | none | unit + `mcp.spatial.integration.test.ts`: tidy/focus by workspace id; edit refused | I1, I2, I3, WS-2 |
| **WS-7** | Confinement: `workspaceScope.ts`, `spawn_board`/`configure_board` containment (+ project containment), cross-workspace relay/write refusal, Jarvis spawn containment | `src/main/workspaceScope.ts` (new), `mcpLifecycle.ts`, `mcpOrchestrator.ts`, `pathSafe.ts` (export `isWithin`), Jarvis spawn facet | none | unit matrix: W→W ok; W→other refused; W→outside refused; `..`/junction/symlink escape refused; PROJECT→workspace derived; outside project refused. Integration through the MCP host | WS-2, WS-3; after I1 (`mcpOrchestrator`), I3 (Jarvis) |
| **WS-8** | Shared context + agent config: `CONTEXT.md` scaffold/read (path-guarded); **live status writer** (O-6: marker-bounded, debounced, mtime-checked, paused while the Brief has unsaved edits); `_project` roll-up; Brief board auto-create; Notify-agents action; Claude Code deny rules + `sandbox.enabled` on macOS/Linux/WSL2 (O-5; merge-preserving, revoke-swept) | `src/main/workspaceContext.ts` (new), `src/main/workspaceStatus.ts` (new; hooks `recordBoardResult` + recap + mirror), `canvasMemory.ts` (dir scaffold), `cliProvisioners/claude.ts`, `cliProvisioners/index.ts`, renderer Brief placement | none | unit: status block from a fixture canvas (Kanban, checklist, recap, results); notes byte-identical after 100 refreshes; markers deleted ⇒ status re-inserted, nothing lost; mtime race ⇒ retry; no write when unchanged; deny/sandbox merge keeps user entries; revoke removes; path guard; unsync-before-status. e2e: Brief shows status + notes; a card moved to In Progress appears within the debounce; a note edit persists. **Spike first:** does `Edit(//m/...)` deny hold on Windows? | WS-2 (WS-4 for scaffold-on-create; lazy scaffold otherwise) |
| **WS-9** | Package P2: `canvas://workspaces`, `canvas://workspace/context`, `spawn_board.workspace`, caller-scoped `canvas://boards`; **publish** + app pin bump (host methods, `APP_TOOLS`, `appModelDrift`) | `canvas-ade-mcp/src/...`, contract tests; app `package.json` pin, `appModel.ts`, `appModelDrift.test.ts` | none | package contract tests; app drift + integration | WS-7 contract |
| **WS-10** | Jarvis: `switch_workspace`, `spawn_board.workspace`, manifest `ws:` tags, header rename, brief injection | `jarvisTools.ts`, `jarvisManifest.ts`, `jarvisPersona.ts` | none | unit: schema/forwarding; tier; manifest | WS-5, WS-6, WS-7 |
| **WS-11** | Migration assists: "Suggest workspaces" (deriveContexts cwd clusters) + "Make workspace from group" | renderer group menu, `BatchConfirmModal.tsx` reuse, `workspaceStore` call | none | unit: cluster → proposal; e2e: accept ⇒ workspaces created | I1, WS-4 |
| **WS-12** | **Format change forces an update** (O-2, §4.9): both release scripts record `minReaderVersion` in `updates.json` and set `minSupported` to their own version when the floor rose; Update now button on the "newer version" open error | `scripts/release.mjs`, `scripts/release-local.mjs` (the `:153` "never a floor" line), `scripts/gen-updates-json.mjs`, `build/updates.json`, the open-failure surface (renderer, [I]) | none | unit: floor unchanged ⇒ no `minSupported` change; floor up ⇒ `minSupported` = this version, on both scripts; previous `updates.json` missing ⇒ treat as unchanged and warn; local ordinary release still never forces. Manual: an old local install meets the forced modal | I2 + I3 merged (O-11) ✓ met; **must ship in a release before WS-2's** |

**MVP for the API/Uploader example = WS-1, 2, 3, 4, 5, 7, 8, 12.** WS-6, 9, 10 and 11 are follow-ups.
Confinement (WS-7) is in the MVP because D-4 is part of the stated goal. WS-12 is in it because v24 is the first floor
raise under the "force on format change" rule.

**Lanes that can run in parallel without file overlap.** Nothing starts until **I2 and I3 have both merged** (O-11). That gate was met on 2026-11-03 (#443, #446).
- **Then, together:** **WS-0** (docs), **WS-1** (allocator files only), **WS-12** (release scripts only) and **WS-2** (data model). Their files don't overlap. WS-12 must be *released* before WS-2's release.
- **After WS-2**, three disjoint lanes:
  - **Lane P:** WS-3 → WS-7. WS-7 also waits on I1/I3.
  - **Lane Q:** WS-4 (needs WS-1).
  - **Lane R:** WS-8.
  - Their only shared file is `preload/index.ts` (WS-3 + WS-4): a tiny additive edit, and whoever merges second rebases.
- **After WS-4:** **WS-5**. I3 is already in by then.
- **After WS-2:** **WS-6** can also run. It touches I-lane files (`spatialTidy.ts`, `mcpGroups.ts`, `jarvisTools.ts`), which are settled once I1/I2/I3 have merged.
- **WS-9** runs in the package repo, in parallel, once WS-7's contract is fixed. Then the pin-bump PR. (The 0.28.x work it was meant to carry was already published and pinned in #445.)
- **Last:** WS-10, WS-11.

Each PR follows the usual ritual (`CLAUDE.md` › Conventions): version bump, plan-viz card, manual dev check before
push, `make check` before merge. WS-2's dev check runs in the dev sandbox project: the ESCHEMAFLOOR guard blocks a
dev build from raising a real project's floor (`CLAUDE.md:153-157`).

---

## 6. Decisions: all answered (2026-11-03)

O-1 to O-12 are answered; the answers are in §0. Three of them came with follow-up choices, which the user picked:
- **O-2:** force on format change (§4.9).
- **O-6:** live status + my notes (§4.5).
- **O-10:** one repo now, many later (§4.1, §4.3).

**Smaller choices I made while writing these up.** Each is easy to change; say so if you disagree.
1. The "Ask the agent to install dependencies" box is **ticked by default** in worktree modes, as in the mock you approved. It doesn't appear in folder-as-is mode.
2. `repoDefaults` lives in `canvas.json`, so a committed `canvas.json` shares "api branches off `release`" with the team. The alternative is the machine-local `session.json`.
3. Expanse **never runs `git fetch`** on its own before branching. The base list shows local and remote-tracking branches as they are.
4. The repo scan for polyrepo projects goes **one level deep**. A repo nested deeper (for example `services/api/`) is reachable through the folder picker but isn't listed.
5. The live status refreshes **at most every 5 s** per workspace and keeps the **last 5** results.
6. Other CLIs (codex, gemini) show only running / exited in the status. Only Claude has the transcript facts.
7. The forced update applies **only when the format's floor rises**. Ordinary releases keep today's tiers, and a local release still never forces otherwise.

**Still to verify while building** (not decisions):
- WS-4: how the dependency prompt is delivered (§4.3 step 5).
- WS-8: whether a `Edit(//m/...)` deny holds on Windows (spike).
- WS-12: where the "newer version" open error is shown.

---

## Appendix: external sources ([DOC], fetched 2026-11-02 via a sub-agent)

- Settings scope (no walk-up for `.claude/settings*.json`): https://code.claude.com/docs/en/settings.md
- Permission path syntax (`//abs`, `~/`, `/`, `./`), anchoring, and `deny` applying immediately: https://code.claude.com/docs/en/permissions.md
- Sandbox (macOS/Linux/WSL2; **not native Windows**; default write scope = cwd): https://code.claude.com/docs/en/sandboxing.md
- `CLAUDE.md` walk-up loading: https://code.claude.com/docs/en/memory.md
- `.mcp.json` project scope, `enabledMcpjsonServers`: https://code.claude.com/docs/en/mcp.md

Gaps in that reading:
- Whether `.mcp.json` walks up is undocumented.
- Cross-scope `deny` vs `allow` precedence was not confirmed.
- `Edit(//m/...)` on Windows is derived from the docs' `//c/**` example, not tested. WS-8 starts with a spike.
