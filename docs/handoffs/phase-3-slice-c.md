# Handoff — Phase 3 Slice C: git worktrees + per-board ports

> For a fresh session. Self-contained. The **last** Phase 3 slice. Phase 3 was split into
> three slices: **A — Persistence** (done, PR #5), **B — Board actions / Full view · Duplicate ·
> ⋯ menu** (done, PR #6), **C — git worktrees + per-board ports** (this handoff). After C,
> Phase 3 is complete → Phase 4 (Design pass & polish).

## First 15 minutes (orientation)

1. `CLAUDE.md` → **Architecture › Git / worktrees** (the locked decisions — reproduced below) +
   **Process model & security (never weaken)** + **Status**.
2. `docs/roadmap.md` → Phase 3 (the Git-worktrees bullet) and the **Deferred** section.
3. This file. Then the seams that already exist (see "What's already in place").
4. The two prior-slice specs/plans for the working cadence + style:
   `docs/superpowers/{specs,plans}/2026-05-30-persistence*.md` and `…board-actions*.md`.

## Branch / PR state (read before branching)

- **PR #5** `phase-3-persistence` (Slice A) — OPEN, base `main`.
- **PR #6** `phase-3-board-actions` (Slice B) — OPEN, **stacked on `phase-3-persistence`**.
- Unrelated open PRs: #4 (docs cleanup), #7 (mcp main wiring) — not part of Phase 3.
- **Merge order matters.** Slice C depends on Slice A's project-folder context (it needs the
  open project dir to place worktrees and to know where the user's repo is). Recommended:
  **merge #5 then #6 into `main` first**, then branch `phase-3-slice-c` off `main`. If they're
  not merged yet, branch off `phase-3-board-actions` (which already contains A+B) and rebase
  later. Confirm with the user which.
- Working cadence used for A and B (repeat it): **brainstorm → spec (`docs/superpowers/specs/`)
  → plan (`docs/superpowers/plans/`) → execute via a sequential subagent Workflow** (implement →
  independent verify → fix-on-fail per task; final review). Push + open PR only on user say-so.

## Scope (Slice C)

From `docs/roadmap.md` Phase 3:

> **Git worktrees**: opt-in toggle on create (reuse-if-exists, never nest-init); worktree per
> Terminal board; keep-on-disk + prompt on dirty delete; per-board port assignment for previews.

Two coupled features:
1. **Git worktrees** — one git worktree per Terminal board, so each agent works in an isolated
   checkout/branch without clobbering the others' files.
2. **Per-board ports** — worktrees isolate *files*, NOT *ports*. Assign a unique localhost port
   per board so each Terminal's dev server and the Browser board previewing it don't collide.

## Locked decisions (CLAUDE.md › Git / worktrees — do NOT re-decide)

- One worktree per Terminal board at **`.canvas-ade/worktrees/<board-id>`** on branch
  **`canvas-ade/<board-id>`**. `.canvas-ade/` is **gitignored in the user's project** (add it to
  the project's `.gitignore` when git-init/reuse happens — it is NOT there yet).
- `git init` is **opt-in** (a toggle on project create); **reuse an existing repo**; **NEVER
  auto-init when nested inside a parent repo** (walk up for a `.git`; if found above the project
  folder, do not init).
- On board delete with a **dirty** worktree: **keep on disk + prompt** (commit / stash / discard /
  keep). **Never** silent `--force`. Always `git worktree remove` (never `rm -rf`).
- Worktrees isolate files, **not ports** — assign per-board ports for localhost previews.
- **Security (never weaken):** `simple-git` runs ONLY in MAIN; renderer drives it over
  frame-guarded IPC (mirror the `pty`/`preview`/`project` handler pattern, incl. the
  `isForeignSender` guard — BUG-033). Never weaken `contextIsolation`/`sandbox`/`nodeIntegration`.

## What's already in place (seams to build on — don't rebuild)

- **`simple-git` `^3.27.0`** is a dependency (`package.json:45`). Unused so far.
- **Schema is ready:** `TerminalBoard` already has optional **`cwd?: string`** and **`port?: number`**
  (`src/renderer/src/lib/boardSchema.ts:38-39`). They round-trip through `toObject`/`fromObject`
  and persist in `canvas.json` (Slice A). No schema bump needed for the worktree path/port — they
  fit the existing fields (worktree path → `cwd`, assigned port → `port`).
- **The git-init toggle seam exists but is INERT:** `createProject(dir, name, { gitInit?: boolean })`
  in `src/main/projectStore.ts:76-88` accepts `gitInit` and ignores it (comment:
  "accepted for forward-compat with Slice C (worktrees) but is inert here"). The WelcomeScreen /
  create flow already passes `{}` (no toggle UI yet). Slice C wires the toggle + the actual init.
- **Project dir is known in MAIN:** `projectStore.getCurrentDir()` returns the open project folder
  — worktrees live under it; the parent-repo `.git` walk-up starts there.
- **Terminal cwd already threads through:** `pty.ts` spawns with `cwd: opts.cwd || os.homedir()`
  (`src/main/pty.ts:322`), and `TerminalBoard.tsx` passes `cwd: board.cwd ?? projectDir ?? undefined`.
  So a board whose `cwd` is set to its worktree path will spawn the agent IN that worktree with
  zero new plumbing — Slice C just needs to populate `board.cwd` with the worktree path.
- **Browser board URL is per-board + persisted** (`board.url`, editable URL bar). A per-board port
  means a board's preview URL becomes `http://localhost:<port>`.
- **IPC handler pattern to copy:** `src/main/projectIpc.ts` (`registerProjectHandlers` +
  `isForeignSender` + registered in `index.ts`). Make `src/main/gitIpc.ts` the same shape.

## Open design questions to resolve in brainstorming (NOT yet decided)

These need a brainstorm + spec before coding (don't assume):

1. **When is a worktree created?** Per Terminal board *on creation* (every Terminal gets one), or
   *opt-in per board* (a "use worktree" toggle on the board)? The roadmap says "worktree per
   Terminal board" — clarify whether that's automatic-when-git-enabled or per-board opt-in. Consider:
   a Planning/Browser board needs no worktree; only Terminals do.
2. **git-init toggle UX:** where does the opt-in live — only on project *create* (WelcomeScreen),
   or also a project-level setting? What's shown when the project is already a repo (reuse) vs
   nested in a parent repo (must refuse to init, but may still reuse the parent? — decide)?
3. **Port allocation strategy:** a fixed pool (e.g. 5173–5199), or probe for a free port at assign
   time? Persisted per board (`board.port`) so it's stable across reopen? What happens on collision
   / when the OS port is taken? How does a Browser board get *paired* to a Terminal's port (does the
   user point the Browser URL at it manually, or is there auto-wiring)?
4. **Duplicate interaction (Slice B):** duplicating a Terminal board makes a NEW board id → it needs
   its OWN worktree + port (the clone can't share the source's worktree/branch). Decide: does
   Duplicate create a fresh worktree for the copy, or copy idle without one until Run?
5. **Dirty-delete prompt UX:** the modal/flow for commit/stash/discard/keep on deleting a board with
   uncommitted worktree changes. Where does it render (a dialog), and how does it call into MAIN?
6. **Worktree lifecycle vs PTY:** the worktree must exist *before* the agent spawns in it (cwd).
   Order of operations on board create/Run; cleanup order on delete (park/kill PTY → prompt →
   `git worktree remove`).
7. **Failure modes:** project has no repo + git-init off → no worktrees (board.cwd = project dir,
   per Slice A). `git` not installed. Worktree add fails (branch exists, locked index). Surface
   clearly, degrade gracefully (don't crash MAIN — mirror the localServer graceful-degrade pattern
   in `index.ts`).

## Suggested decomposition (refine in the plan)

1. **`src/main/git.ts` (pure-ish MAIN module over `simple-git`)** — `isRepo(dir)`, `parentRepoAbove(dir)`
   (walk-up `.git` detection for never-nest-init), `initRepo(dir)`, `addWorktree(projectDir, boardId)`
   → returns the worktree path + branch, `removeWorktree(projectDir, boardId, { force? })`,
   `worktreeStatus(path)` (clean/dirty). Unit-testable against a temp git repo (like
   `projectStore.test.ts` uses temp dirs).
2. **Port allocator** (`src/main/ports.ts` or fold into git module) — assign/track a free port per
   board; persist via `board.port`. Pure allocation logic unit-tested; the actual bind-probe (if
   chosen) is a thin MAIN helper.
3. **`src/main/gitIpc.ts`** — `registerGitHandlers(ipcMain, getWin)` with `isForeignSender` guard:
   `git:enableForProject` / `worktree:create` / `worktree:remove` / `worktree:status` / `port:assign`.
   Register in `index.ts` next to `registerProjectHandlers`.
4. **Wire the create-dialog git toggle** (WelcomeScreen + `projectStore.createProject` gitInit →
   actually init/reuse, write `.canvas-ade/` into the project `.gitignore`).
5. **Terminal board → worktree + port:** on Terminal create (when git enabled), create the worktree,
   set `board.cwd` = worktree path and `board.port` = assigned port; the existing spawn plumbing does
   the rest. Dirty-delete prompt on remove.
6. **Browser board ↔ port:** make a board's preview point at its assigned port (URL default /
   pairing — per the brainstormed decision).
7. **Tests:** git module against temp repos (init/reuse/never-nest, worktree add/remove, dirty
   detection); port allocator; round-trip that `cwd`/`port` persist (already covered by Slice A
   schema tests — extend if new fields).

## Gotchas / invariants (carry forward)

- **Never weaken security:** `simple-git` in MAIN only; frame-guarded IPC; browser content never to
  the PTY channel.
- **Never `rm -rf`** a worktree; always `git worktree remove`. **Never silent `--force`** on a dirty
  worktree — prompt first.
- **Never nest-init:** if a `.git` exists at or above the project folder, do not `git init`.
- **`.canvas-ade/` must be gitignored in the user's project** (write it on enable; it's not there in
  this repo because that's the *user's* project, not Canvas ADE itself).
- **node-pty stays `1.2.0-beta.13`** (winpty-free; spaced repo path `Z:\Canvas ADE`). Don't touch.
- **Windows:** `simple-git` + worktrees on a spaced path — quote paths; test `worktree add` works
  under `Z:\Canvas ADE` and under a project path that may also contain spaces.
- A `pnpm dev` may be left running — kill stale Electron/node first.
- Stale agent worktrees from prior sessions exist under `.claude/worktrees/` + branches
  `worktree-wf_*` — unrelated to this feature; ignore or `git worktree remove -f` if cleaning.

## Carry-forward items NOT in Slice C (note, don't do here)

- **Agentic session resume** — deferred to its own slice (roadmap "Deferred feature" note). Restored
  terminals are idle.
- **Full-view enter/exit animation** — deferred to Phase 4 (roadmap Phase 4 note; native views can't
  be CSS-animated).
- **Open Slice-A/B bugs of note (Low):** BUG-025 (load clamps sub-MIN geometry), BUG-050 (focus dim
  is HTML opacity; native views ignore it — Phase 4). The drag-ghost (Electron #43961) was fixed in
  Slice B (`preview.ts` `setVisible(false)` on detach).

## Done when

- git-init toggle works (init / reuse / refuse-nest); a Terminal board (git enabled) spawns its
  agent inside its own `.canvas-ade/worktrees/<id>` on `canvas-ade/<id>`; each board has a stable
  per-board port that survives reopen; dirty-delete prompts (commit/stash/discard/keep) and never
  force-removes; full gate green (`pnpm typecheck && lint && format:check && test && build`); new
  MAIN modules unit-tested against temp repos. Then Phase 3 is complete.
