# gitdiff — intended-behavior checklist

Feature audited: **`gitDiff`** — the swarm orchestrator's read-only working-tree diff for a
terminal board, surfaced in the Command board's result zone + recap timeline (`+N −M` chip +
"view diff" panel) and exposed agent-side as the `git_diff` MCP tool.

Intent reconstructed from: module docstrings (`src/main/gitDiff.ts`, `mcpOrchestrator.ts`,
`diffStat.ts`), the wiring chain, the test suite, `e2e/gitDiff.e2e.ts`, and the command-board
research (`docs/research/2026-06-15-command-board/{README,phase-c-plan,orchestrator-followups}.md`).

> **Intent assumptions** (stated, not asked — resolved by inference):
> - **A1.** "Working-tree diff" means **tracked changes vs `HEAD`** (staged + unstaged). Untracked
>   (never-`git add`-ed) files are **out of the stated intent** ("captures staged + unstaged"),
>   even though a user/agent would reasonably expect newly-created files to appear. → graded as a
>   gap because it diverges from user expectation, not from the literal docstring.
> - **A2.** The 100 KB cap (`GITDIFF_MAX_BYTES`) is a **downstream-payload** bound (what the chip /
>   view-diff / agent receives), not a promise of bounded MAIN-side memory.
> - **A3.** `parseDiffStat` is **approximate by design** (the `+N −M` chip), explicitly NOT
>   `git --numstat`; exactness is a non-goal for the chip but correctness on ordinary content is
>   still expected.
> - **A4.** The renderer consumer is **best-effort**: any error / non-repo / missing api → `''` →
>   chip hidden (no user-facing error surface is intended).
> - **A5.** "Read-only" is a hard security invariant: `simple-git` in MAIN only, `diff` only, no
>   path that can mutate a repo.

## Behavior checklist (graded in coverage-matrix.md)

### Core contract
- [I1] Resolve a board's spawn cwd via injected `getCwd` (= pty.ts `getTerminalCwd`); no cwd → `''`.
- [I2] cwd not a git repo → `''` (never throws).
- [I3] Return the raw unified `git diff HEAD` (staged + unstaged tracked changes).
- [I4] Repo with **no commits yet** (HEAD unresolvable) → fall back to unstaged-only `git diff`.
- [I5] A **non-HEAD** git failure (I/O, corrupt repo, missing binary) **must surface** (re-throw),
  not be masked by the no-HEAD fallback.

### Orchestrator policy (the sink that owns the rules)
- [I6] board-not-found → throw (`gitDiff: board not found`).
- [I7] non-terminal board → throw (`gitDiff: not a terminal board`) — browser content never implies a repo.
- [I8] registry has no `gitDiff` wired → throw (`gitDiff not available`).
- [I9] Clamp output to `GITDIFF_MAX_BYTES` (100 000) measured in **UTF-8 bytes**, cut on a char
  boundary (no split multibyte / U+FFFD), result strictly ≤ 100 000 bytes.

### Security / process model (never weakened)
- [I10] `simple-git` runs **only in MAIN**; renderer never touches it.
- [I11] Strictly **read-only** — only `git diff` / `checkIsRepo`; no write/mutation vector.
- [I12] Renderer→MAIN IPC (`mcp:gitDiff`) is **frame-guarded**; a foreign sender → `forbidden`.
- [I13] Renderer holds **no token**; it only requests the action.

### Wiring (reachable end-to-end, output consumed)
- [I14] Full chain live: `useCommandDispatch` → `window.api.mcp.gitDiff` → `preload mcp:gitDiff` →
  `mcpOrchestratorIpc` → `mcp.gitDiff` → `orchestrator.gitDiff` → `registry.gitDiff` →
  `boardGitDiff` → `simple-git`.
- [I15] Output consumed downstream: `parseDiffStat`/`hasDiff` → `+N −M` chip + "view diff" pre in
  `TaskCard`, `CommandRecapView` (timeline), `GroupsView` (zone rollup).
- [I16] Agent-facing `git_diff` MCP tool routes to `orchestrator.gitDiff` (PR-2b).
- [I17] CANVAS_E2E seam (`__canvasE2EMain.gitDiff`) drives the same live path in-process.

### Diffstat parsing (the chip)
- [I18] Empty/nullish raw → `EMPTY_DIFFSTAT` (0/0/0).
- [I19] Count `+`/`-` content lines, excluding `+++`/`---` file headers; one file per `diff --git`.
- [I20] `hasDiff` true only for non-blank raw (gates the chip + view-diff).

### Behavioral coverage of diff cases (rubric)
- [I21] Modified tracked file → shown + counted.
- [I22] Added file (`git add -N` intent-to-add) → shown (`new file mode`) + counted.
- [I23] Untracked (never-added) new file → **see A1** (currently invisible).
- [I24] Deleted tracked file → shown (`deleted file mode`) + counted.
- [I25] Renamed file → shown (delete+add, or rename header with `git mv`).
- [I26] Binary file → shown (`Binary files … differ`), 0/0 content + 1 file.
- [I27] Empty diff (clean repo) → `''` → chip hidden.
- [I28] Large diff (> 100 KB) → clamped, still parseable.
- [I29] Determinism: same tree → same output; `parseDiffStat` pure.
- [I30] Performance: bounded resource use on a large/hostile working tree (per A2).
