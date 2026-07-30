# Audit Phase 4 kickoff — Bundle & hygiene (R12 · R13 · R15)

> **You are Audit Phase 4** on branch `perf/bundle-hygiene-phase4`, worktree
> `.worktrees/perf-phase4`, base `9e199f39` (main after the Phase 3 merge, v0.43.0).
> Read this in full, then `CLAUDE.md`, then AUDIT.md §6 rows R12/R13/R15 + §7's Phase 4
> gate, then **confirm your plan with the user before any large edit**.
> Estimated **2.5 d**. Written 2026-07-30 by the Phase 3 session as its handoff.

## Mission

The last unclaimed lane of the 2026-07-25 project-switch perf audit
(`docs/reviews/2026-07-25-project-switch-perf-audit/AUDIT.md`). Phases 0–3 are shipped
(#390 Phase 0 tail · #397 Phase 2 · #402 Phase 3); Phase 1 (R9/R16/R4/R10) is **in flight
on another lane** (`switch-ux-phase1` — do not touch its zone). Phase 4 is independently
shippable and independently revertable.

**§7 gate, verbatim:** *entry chunk gzip below a budget asserted in `pr.yml`; idle CPU
measured with zero boards open.*

## R12 — Lazy-load the diagram bridge; drop `addon-webgl` (P-5, 1.5 d)

- The bridge is a **side-effect import at `src/renderer/src/main.tsx:10`**
  (`import './canvas/boards/planning/diagramPackageBridge'`) that wires the
  `@expanse-ade/diagram` host seams (styles.css, ELK worker, Icon renderer) before any
  diagram mounts. Move registration to the first Planning/Data-flow board mount. The seam
  map is in the bridge file's header — read it before moving anything; the ELK worker and
  styles.css are the parts most likely to break subtly when deferred (a diagram that
  mounts before styles arrive renders unstyled for a frame, or the worker races layout).
  **Dev-check this visually**: open a project with an existing diagram, confirm
  first-mount renders correctly, then a cold-start project where the FIRST diagram is
  created fresh.
- **PREMISE CORRECTION (verify-before-spend, the R3/R11 lesson):** AUDIT calls
  `addon-webgl` "unused" — it is **not unimported**. Two references exist, both in smoke:
  `src/renderer/src/smoke/TerminalSmoke.tsx:4` (static import — this one puts it in a
  chunk) and `src/renderer/src/smoke/useRendererSmoke.ts:43` (dynamic import). CLAUDE.md
  says the real terminal uses the DOM renderer, webgl not loaded. Decide with evidence:
  either the smoke usage is itself vestigial (then remove usage + dep together), or the
  smoke genuinely exercises it (then "drop addon-webgl" dies as a measured negative,
  recorded in AUDIT §9 like DL-1). Check whether the smoke files even reach the entry
  chunk — if Vite already code-splits them, the dep's bundle cost may be ~zero and the
  win is only `node_modules` hygiene.
- **gzip budget assertion in `pr.yml`** (the CI `check` job): measure the entry chunk
  before/after (`pnpm build`, gzip the renderer entry), set the budget just above the
  post-R12 size so regressions fail loudly but noise doesn't. This is half the §7 gate.

## R13 — Kill the always-on timers (P-7 · P-8, 1.5 d)

Four independent edits; each needs a before/after idle-CPU observation (see Measurement):

1. `src/renderer/src/canvas/boards/useBrowserAutoConnect.ts` — gate on
   `browserBoards.length > 0`; today it ticks with zero Browser boards.
2. `src/renderer/src/canvas/boards/terminal/useRunTimer.ts` (+ its test) — its output
   re-renders `TerminalBoard.tsx` every tick; hoist the display into a leaf component so
   the tick re-renders only the leaf. Phase 2's root-memo work (#397) is adjacent — read
   its build-history entry so you don't undo its boundary.
3. `src/main/ptyLifecycleMonitor.ts` (wired in `pty.ts:37`, used ~`pty.ts:274`) — make it
   event-driven off `onData` quiescence instead of polling. R7's flow-control landed in
   Phase 3 (`ptyHost/flowControl.ts`) — the daemon-side data path changed; read
   `daemonMain.ts`'s onData wiring before assuming where quiescence is observable.
4. `src/main/claudeBootDetect.ts:71` — `ensuredDirs` grows forever; delete entries on
   board removal.

## R15 — Hygiene sweep (H-1…H-5 · PS-5, 1 d)

- **Prune orphaned worktrees** — `git worktree list` shows 12+ under `.worktrees/`.
  **COORDINATE FIRST**: `.claude/coordination/ACTIVE-WORK.md` is the source of truth for
  which are live. Live as of this writing: `scrollback-flake`, `evalin-sweep`,
  `terminal-clip`, `orch-observability` (+ possibly others started since). `mainio-phase3`
  is MERGED — safe to remove once its session closes (expect `remove-worktree.ps1`'s
  documented false-success if a cwd lock lingers; the leftover empty dir is benign).
  Always `remove-worktree.ps1` / `git worktree remove` — never `rm -rf`. Dirty worktree ⇒
  keep on disk + ask the user (locked rule).
- **Stray root `.md`s** — the audit counted 4. **⚠ `PHASE3-KICKOFF.md` at the repo ROOT
  belongs to the cloud-TTS voice lane — DO NOT delete or edit it without confirming with
  its lane/user.** Identify each stray's owner before touching (git log the file).
- **MCP pin reconciliation (H-class)** — package.json + lockfile are correct at
  `@expanse-ade/mcp` **0.23.0** (#403). Two debts remain:
  (a) `CLAUDE.md:212` still says *app pin `0.18.0-rc.7`* — stale by five versions;
  CLAUDE.md is durable-contract, so this edit lands on `main` directly or in this PR per
  the convention (ask the user which).
  (b) **MAIN checkout's shared `node_modules` still holds 0.22.1** — `pnpm install`
  demands a from-scratch purge (module-root mismatch) which CANNOT run while sibling
  lanes are junctioned to it. Schedule at an idle window, run it **foreground in a real
  TTY from `M:\expanse\expanse-desktop`** (the purge prompt silently no-ops in
  non-interactive shells — documented memory).
- Stale schema-mirror comments; dead `hotkey:failures` UI + 4 stale comment blocks
  (locations in the audit's H findings); **release-tags decision is the user's call** —
  present options, don't decide.
- **Doc-lifecycle debt to settle in this PR:**
  `docs/reviews/2026-07-25-project-switch-perf-audit/PHASE3-KICKOFF.md` should have been
  deleted in #402 (kickoffs die in the PR that merges their feature) — delete it here,
  and delete THIS file (`PHASE4-KICKOFF.md`) in the same PR.

## Measurement (both §7 gate halves need numbers, not vibes)

- **Entry chunk**: gzip size before/after R12, recorded in AUDIT §9; the `pr.yml`
  assertion pins it.
- **Idle CPU with zero boards open**: before/after R13. Use a packaged or dev build
  sitting idle on an empty project; sample main+renderer process CPU over ≥60 s
  (Task Manager averages lie — use `Get-Counter` or repeated `Get-Process` deltas).
  Phase 3's honesty precedent applies: if a number is noise-dominated, record that it is
  (AUDIT §9 item 8 shows the pattern) — don't cherry-pick.
- Boot marks exist since Phase 3 (`bootTiming.ts`, stdout `[boot]` line always,
  JSONL sink under `CANVAS_BOOT_TIMING=1`) if you need boot-adjacent evidence.

## Rituals — all MUST (Phase 3's exact list, plus two new lessons)

1. **Plan-viz first**: Planning board + checklist via the `canvas-ade` MCP before any
   implementation; keep it live with `update_planning_element` (read
   `canvas://board/{id}/planning` for ids; never re-append). Known trap: `spawn_board`'s
   `seed` can silently miss — seed nothing, populate with `add_planning_elements` after.
2. **Design artifact**: R12/R13/R15 are non-visual — record "N/A" explicitly on the plan
   board, don't silently skip. (R12 still needs the visual dev-check above — that's
   verification, not design.)
3. **Version bump**: base is 0.43.0 ⇒ budget **0.44.0** (minor, audit-phase precedent) —
   but MULTIPLE lanes are in flight; recompute off the tip at PR time and again after any
   rebase, and update the PR title/body to match.
4. **Manual dev check BEFORE push**, title-stamped:
   `$env:CANVAS_DEV_TITLE='PR#NNN phase4'; pnpm dev` — confirm the taskbar title before
   trusting what you see.
5. **Push cheap / merge full**: plain push = scoped Windows leg. **Merge gate = FULL
   matrix, invoked as `E2E_PRECOMMIT=1 pnpm test:e2e:matrix`** — bare invocation runs
   retries:0 and turns documented flakes into hard failures. Linux leg mandatory at the
   gate. Log matrix output to a FILE (`> log 2>&1`) — a killed wrapper task orphans the
   pipe and you lose the verdict (Phase 3 recovered one via
   `docker events --filter event=die`, don't rely on that).
6. **Reviewer**: reply inline on every `[critical]`/`[warning]` on its own thread; nits
   under the no-reply heading need nothing.
7. **`gh pr edit --title` can silently fail** (GraphQL Projects-classic deprecation error
   swallows the mutation) — VERIFY with `gh pr view <n> --json title` before any squash
   merge; the squash subject inherits the title (Phase 3's rode in stale as v0.42.0).
8. **DO NOT MERGE without explicit per-PR authorization from the user.**
9. After merge: build-history entry (append, main direct, docs-only push skips e2e) +
   `pwsh .claude/tools/signal-merge.ps1 -Pr <n> -Subject "..."` + update your
   ACTIVE-WORK row + `write_result` on the plan board.

## Known ambient floors on this box — confirm the count, don't chase

- **Unit**: 5 failures (`pathSafe` ×2 symlink, `pty.recapenv` ×3) — pre-existing on main.
- **e2e workers:2 contention**: `terminal.e2e.ts:62` / `boardKeyboard:58` block pushes
  probabilistically — verify 5/5 at `workers:1`, re-push with `E2E_WORKERS=1` (never
  `--no-verify` for this).
- **Linux Docker leg** can die at container level (`unexpected EOF`) — infrastructure,
  re-run. It once filled C: — check ≥50 GB free before the leg.
- **E2E SLOT coordination**: the `scrollback-flake` lane may be running repeated-run
  batteries on this box — check its ACTIVE-WORK row / ask before launching a leg.

## Zone + coordination

Declared zone (already on the ACTIVE-WORK row): `src/renderer/src/main.tsx` ·
`canvas/boards/planning/diagramPackageBridge*` · `smoke/{TerminalSmoke,useRendererSmoke}` ·
`boards/{useBrowserAutoConnect,terminal/useRunTimer,TerminalBoard}` ·
`src/main/{ptyLifecycleMonitor,claudeBootDetect}.ts` · `.github/workflows/pr.yml` ·
R15 hygiene targets · `package.json`.

Collision watch: **`terminal-clip`** owns the terminal fit path
(`useTerminalSpawn.ts` + terminal e2e specs) — `TerminalBoard.tsx`/`useRunTimer` are
adjacent; coordinate on the board before editing if that lane is still open.
**`switch-ux-phase1`** owns the switcher/dock surface — disjoint, stay out.
**`evalin-sweep`** owns `e2e/` spec transport — if you touch e2e specs, rebase over it.

MCP liveness: `.mcp.json` was provisioned by `new-worktree.ps1`; if the SessionStart
banner says config missing/stale, copy MAIN's `.mcp.json` and `/mcp` reconnect.
