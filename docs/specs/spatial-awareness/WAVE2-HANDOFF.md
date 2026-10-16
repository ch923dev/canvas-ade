# Wave 2 handoff — spatial awareness + role-aware tidy (coordinator brief)

You are the **Wave 2 coordinator** for the spatial-awareness epic. The previous coordinator
session finished Wave 0 (contract) and Wave 1 (four fixes), then handed off to you
on 2026-10-16. Work under **Option B**, the model the user chose:
- you coordinate;
- background subagents implement each lane in its own worktree, made with `new-worktree.ps1`;
- you review every diff;
- **the user does the dev checks and runs the merges.**

## 0. Read first, in this order

1. `M:\expanse\expanse-desktop\CLAUDE.md`: the repo contract, covering version bumps, plan-viz
   first, design artifacts, dev checks, the hooks and the merge ritual.
2. `M:\expanse\expanse-desktop\.claude\coordination\ACTIVE-WORK.md`: the live lanes and the
   integration tip.
3. Memory: `expanse-full-review-2026-10.md`, plus the `MEMORY.md` index.
4. This folder, all under `M:\expanse\expanse-desktop\.worktrees\spatial-awareness\docs\specs\spatial-awareness\`:
   - `SPEC.md`: contracts C1–C10, decisions D1–D10, the lane map (§6) and the waves.
   - `ROLE-LAYOUT.md`: the role-aware tidy. Roles, scenes, templates, sizing, and scenarios
     S1–S15 as golden fixtures.
   - `DESIGN.md`: wireframes W1–W7.

## 1. State you inherit

- **Wave 1 is merged:** #428 `0274fee4` · #429 `f0365ee8` · #430 `c8a536db` · canvas-ade-mcp#17
  `a42eac2d` (0.26.0). Desktop `main` = `0236048b` (v0.47.9).
- **The e2e matrix is INCOMPLETE.** The Windows leg passed, but Linux was skipped because Docker
  was down (`.claude/coordination/e2e-async/last-result.json`). That verdict is binding: before
  any Wave 2 PR that reaches the running app is pushed, ask the user to start Docker Desktop and
  run `make e2e-async`. Pure-lib lanes may proceed meanwhile.
- **GitHub CI is red on every PR for repo-wide reasons.** The SCA step has blocked since
  2026-08-07 and skips typecheck, lint and test; `claude-review` errors in about 270 ms because
  its token is probably expired. Neither is a PR's fault, so say so in each PR body. The local
  gates are the real gate.
- **MCP 0.26.0 is merged but probably NOT published to npm yet**; the user owns tag and publish.
  L8 builds on canvas-ade-mcp `main` regardless. The app pin bump in Wave 3 needs the published
  version.

## 2. Ask the user FIRST (one AskUserQuestion, recommended option first)

- **D7:** may `roles` resize boards? Recommend yes, by class: flexible, aspect-locked previews,
  rigid planning/kanban/file.
- **D8:** what does "tidy up" mean? Recommend (a) `roles` as the default, falling back to `fit`.
- **D9:** only classifications reach MAIN, never raw launch lines? Recommend yes.
- **D10:** a loopback origin-port observer to link the api terminal to its browser? Recommend yes.
- Sign-off on `ROLE-LAYOUT.md` §7 (S1–S15) and `DESIGN.md` W6/W7.

Record the answers in `SPEC.md` §2 (one commit on `feat/spatial-awareness`), then brief the lanes.
L5, L6, L7, L9 and L8 do **not** depend on D7–D10, so start them right away.

## 3. Wave 2 lanes (SPEC §6)

| Lane | What | Depends on |
|---|---|---|
| L5 | C1 mirror (incl. the C9 signal fields + sanitizer) + C2 layout v2 (+ `role`) + screenInfo + spatialGeometry + the C5 applier pre-split | — |
| L6 | C3 `deriveContexts` (incl. the `port` edge) | — |
| L7 | C4 `fitLayout` | C2 geometry (stub OK) |
| L9 | C9 `boardRoles.ts` (roles, scenes, units incl. the TEAM unit) | C3 types (stub OK) |
| L10 | C10 `roleLayout` + `roleTemplates` + golden S1–S15 + property tests | L9 types (stub OK). **Freeze goldens only after D7–D10 + sign-off** |
| L11 | C9 producers: `agentClassify`, `roleSignalsStore`, MAIN `previewOriginPorts` (D10) + one wiring line | **L5 merged** (for the wiring line), D9/D10 answered |
| L8 | Package 0.27.0 in `M:\expanse\canvas-ade-mcp`: C6 (`roles` mode, `primary`/`resize`, the group tools, `canvas://contexts`, warn-on-skip) | canvas-ade-mcp main `a42eac2d` |

Cap: about 4 live worktrees. Suggested batches: A = L5 · L6 · L9 · L7, then B = L10 · L11 · L8.
Lane worktrees branch from `origin/main` and read the spec by absolute path from this worktree.
`feat/spatial-awareness` carries the docs only. The spec docs are deleted in the PR that finally
ships the feature (doc lifecycle).

## 4. The ritual per PR (no exceptions)

1. **Plan-viz:** keep the plan board live. It's a Kanban with one column per wave, canvas id
   `b8b4c254-1a51-4709-87a1-e5e02220a8ca`. Read `canvas://board/<id>/cards`, then
   `move_card`/`update_card`. Never re-add a card that already exists. `write_result` on it when
   Wave 2 is done.
2. **Subagent brief:** give the lane its exact contract section, the file ownership (SPEC §6),
   "pnpm via Bash only, never `pnpm install` through the junction", `env -u CANVAS_RECAP_BOARD`,
   the max of 700 code lines per file, and a version bump in the PR (patch, sequential). Recompute
   the bump after each merge.
3. **You review the diff.** Every load-bearing claim gets a check against the code.
4. **The user dev-checks before the push** (title-stamped `pnpm dev`, sandbox project, orchestration
   enabled for that sandbox). Pure-lib lanes have no UI: say so, and offer a unit-level demo instead.
5. **Push** (the pre-push hook runs the `@core` smoke). Don't pipe a push through `tail`, because that
   masks the exit code.
6. **Open the PR.** For any later edit use `gh api -X PATCH`, because `gh pr edit` is broken.
7. **The USER merges.** The auto-mode classifier blocks agent merges even on explicit approval.
   Give them `! gh pr merge <n> --repo ch923dev/canvas-ade --squash`, one at a time, **without**
   `--delete-branch`.
8. **Between merges:** `git fetch && git rebase origin/main` the next lane. The version line will
   conflict: keep the lane's number, and confirm the committed diff is only that line. Then
   `--force-with-lease`.
9. **After each merge:** `pwsh .claude/tools/signal-merge.ps1 -Pr <n> -Subject "<subj>"`. After the
   last native-surface merge, add `-E2E`. Add a `docs/archive/build-history.md` entry (a docs-only
   push to main skips e2e).
10. **Teardown:** the user runs `remove-worktree.ps1`, because the classifier blocks it for agents.

## 5. Known gotchas

- **The `pathSafe` unit tests fail environmentally (8.3 TEMP path)**, on main too. That's 2
  failures, and they are not regressions.
- A dev sandbox lives under `%APPDATA%`, so Claude Code inherits a home-level `~/.mcp.json`. A
  stale one (port 51897) was deleted on 2026-10-16. If `/mcp` shows ECONNREFUSED, check for a
  home file again and confirm orchestration is enabled for the sandbox.
- **Never run both e2e legs at once (false red).** A RED in the diff's area is a finding, not a
  flake.
- **The C3 hub rule drops cables from a lead with ≥3 of them.** L9's TEAM unit exists to cover
  exactly that, so don't "fix" C3 instead.
- **Out of scope unless the user says so:** the SCA dependency lane and the review-token rotation.
  Both are pending user decisions.

## 6. Done means

All Wave 2 PRs are merged, `make e2e-async` is GREEN on both legs, the plan board is current with
`write_result`, the build history is appended, and the memory file is updated with the Wave 2
state. Then propose Wave 3 (pin bump → I1 ∥ I2) to the user.
