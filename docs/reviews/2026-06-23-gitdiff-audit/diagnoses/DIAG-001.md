# DIAG-001 — "failing tests + e2e" premise: reproduced as ALL GREEN (no failures exist)

**Class:** stale-premise / no-repro (NOT real-bug, NOT flaky-env).

The goal directed me to "reproduce each failing test and the e2e" and root-cause them. I ran the
entire gitdiff test surface — unit, integration, the orchestrator policy suite, and the e2e — and
**nothing fails**. The premise that there are failing tests/e2e does not hold against the current
working tree (`main`, build green). This is the honest root-cause of "the failures": there are none.

## Repro (exact commands + output)

Environment: Node 22.17.0, pnpm 9.15.9 (PATH-prefixed per the session note), Windows.

### 1. Unit + integration (feature-scoped)
```
$ vitest run gitDiff diffStat mcpOrchestratorIpc.integration
 Test Files  3 passed (3)
      Tests  21 passed (21)
```
Covers: `gitDiff.test.ts` (5 — no-cwd / non-repo / diff HEAD / no-HEAD fallback / re-throw),
`diffStat.test.ts` (parseDiffStat + hasDiff), `mcpOrchestratorIpc.integration.test.ts` (the
`mcp:gitDiff` channel forward + boardId validation + foreign-frame deny).

### 2. Orchestrator policy suite
```
$ vitest run mcpOrchestrator.test
 Test Files  1 passed (1)
      Tests  99 passed (99)
```
Includes `describe('gitDiff (PR-2, read-only diff)')` (`mcpOrchestrator.test.ts:253-296`):
returns diff · unknown board throws · non-terminal throws · not-wired throws · clamp 100k ·
clamp-by-bytes-not-code-units (CJK). All green.

### 3. E2E (real Electron app + real PTY + real git repo)
```
$ electron-vite build         # ✓ built in 7.46s
$ playwright test gitDiff
  ok 1 …returns the working-tree diff for a terminal board whose cwd is a git repo (2.5s)
  ok 2 …SECURITY: rejects a non-terminal board (471ms)
  ok 3 …rejects an unknown board id (8ms)
  3 passed (5.3s)
```
The e2e seeds a throwaway git repo with a modified tracked file + an intent-to-added new file,
spawns a real terminal board, and asserts the live diff contains `line two CHANGED`, `line four`,
`fresh.txt`, and `new file mode` — all pass.

## Isolation / why no failure

- The full chain (`useCommandDispatch` → IPC → orchestrator → `boardGitDiff` → simple-git) is
  intact and exercised; the e2e proves the real diff returns end-to-end.
- One **cosmetic** stderr line appears in the e2e: `warning: in the working copy of 'hello.txt',
  LF will be replaced by CRLF…`. This is git's autocrlf notice in the *throwaway temp repo*; it does
  not affect the assertions (line-content matches) and the test passes. Not a failure.

## Conclusion

There is no failing test or e2e to root-cause. The audit therefore pivots from "diagnose failures"
to "grade completeness against intent" — the real, demonstrated gaps are catalogued in
`punch-list/` (GAP-001 … GAP-007) and graded in `coverage-matrix.md`. No test was modified.

> Note on possible misread of the premise: the e2e historically had a **Windows-teardown flake**
> (`docs/research/2026-06-15-command-board/phase-c-plan.md:39` — "the gitDiff Windows-teardown
> flake") and a prior run's setup once **escaped into the host repo + clobbered git identity**
> (mitigated by the hermetic `GIT_DIR`/`GIT_WORK_TREE` pinning, `e2e:22-41`). Neither reproduces
> now; if "failing e2e" referred to that flake, it is already fixed. See GAP-005 for hardening the
> behavioral coverage so a regression here would be caught, not flaky.
