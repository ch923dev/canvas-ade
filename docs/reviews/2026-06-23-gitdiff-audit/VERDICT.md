# gitdiff — VERDICT

> **RESOLUTION (2026-06-23):** All 7 gaps below were FIXED on branch `fix/gitdiff-gaps` via a
> file-disjoint workflow (commit `fix(gitdiff): close 7 completeness-audit gaps`). Gate green
> (typecheck · lint · 3286 unit · gitDiff e2e 3/3); adversarial review APPROVE, 0 must-fix.
> The verdict below is preserved as the **as-found** record. GAP-001 was implemented as
> "include untracked files (read-only)" per the user's decision.

---

## Verdict: COMPLETE for shipped scope · INCOMPLETE against the full rubric — **0 blocking gaps**

The `gitDiff` feature (read-only working-tree diff → Command-board result zone / recap timeline,
plus the agent-facing `git_diff` MCP tool) is **functionally complete, correctly wired end-to-end,
and fully green**: every existing test passes (120 feature-scoped unit/integration + 99 orchestrator
+ 3 e2e), the e2e proves the real diff returns through the live chain, and the security invariants
hold (simple-git MAIN-only, read-only, frame-guarded IPC, byte-accurate 100 KB clamp).

**There are no failing tests and no failing e2e** — the goal's premise of failures does not hold;
see `diagnoses/DIAG-001.md` (reproduced all-green with exact commands/output).

It is **not "fully realized" against the completeness rubric**: there are 6 genuine, demonstrated
gaps (2 Medium, 4 Low). **None is release-blocking** — each is a divergence from full
behavioral/resource/coverage intent, not a break in the shipped happy path.

## Gap counts by class
| Class | Count | IDs |
|-------|:-----:|-----|
| real-bug | 1 | GAP-003 |
| incomplete-impl | 4 | GAP-001, GAP-002, GAP-006, GAP-007 |
| stale-doc / wiring | 1 | GAP-004 |
| test-coverage | 1 | GAP-005 |
| stale-premise (failures) | — | DIAG-001 (no-repro) |

By severity: **Medium ×2** (GAP-001, GAP-002) · **Low ×4** (GAP-003, GAP-004, GAP-005, GAP-006, GAP-007 — 5 Low).

## Gaps ranked (highest first)
1. **GAP-001 (Med)** — Untracked (never-`git add`-ed) files are invisible in `git diff HEAD`; an
   agent that creates new files without staging produces a result zone that omits them. *Demonstrated.*
2. **GAP-002 (Med)** — The 100 KB clamp bounds only the downstream payload; simple-git streams the
   **entire** diff into MAIN memory first (no maxBuffer), so a huge/hostile tree can spike/OOM the
   privileged process. The clamp docstring overstates the protection. *Demonstrated.*
3. **GAP-003 (Low)** — `parseDiffStat` undercounts content lines whose body starts with `--`/`++`
   (skipped as `---`/`+++` headers) → chip miscount. *Demonstrated.*
4. **GAP-005 (Low)** — No test for real-git delete/binary/clean/no-commits-fallback, nor for the
   rendered chip/view-diff; the e2e covers one happy path only.
5. **GAP-004 (Low)** — Stale comments (`mcp.ts:105`, `gitDiff.e2e.ts:15`, `mcpRegistry.ts:91`) deny
   the `git_diff` MCP tool that the pinned `@expanse-ade/mcp@0.13.0` already ships + routes; no
   over-the-wire test. *Demonstrated against the installed package.*
6. **GAP-006 (Low)** — Diff is HEAD-relative + repo-wide; conflates pre-existing changes and ignores
   a subdir cwd. Honestly labeled, but readable as agent-attributed.
7. **GAP-007 (Low)** — No timeout/abort on the git invocation; a hung git pins the task in
   `reporting` forever.

(No item is ranked "blocking". If a single item were to be promoted, GAP-001 is the closest to a
user-visible correctness expectation; GAP-002 is the closest to a security/resource concern.)

## Root cause of the "failing test(s) + e2e" — one line each
- **Failing unit tests:** none — all 219 relevant tests pass; the premise is stale (DIAG-001).
- **Failing e2e:** none — all 3 `gitDiff.e2e.ts` tests pass (5.3s); the only stderr is a cosmetic
  autocrlf warning in the throwaway temp repo (DIAG-001). Any historical "gitDiff Windows-teardown
  flake" does not reproduce now.

## Intent assumptions (stated, used for grading — full list in `intent.md`)
- **A1** "Working-tree diff" = tracked changes vs HEAD; untracked files are out of the literal
  docstring intent but inside reasonable user expectation → graded as GAP-001.
- **A2** The 100 KB cap is a downstream-payload bound, not a MAIN-memory guard → GAP-002.
- **A3** `parseDiffStat` is approximate-by-design (chip, not numstat) → caps GAP-003 at Low.
- **A4** The renderer consumer is best-effort: any error/non-repo → `''` → chip hidden.
- **A5** "Read-only" is a hard invariant (simple-git MAIN-only, `diff` only) — upheld throughout.

## Definition-of-done self-check (against the output contract)
- [x] Intended behavior written down — `intent.md` (I1–I30 + assumptions).
- [x] Every gitdiff path traced entry→output, mapped to intent — `coverage-matrix.md`.
- [x] Every failing test + the e2e reproduced + root-caused — `diagnoses/DIAG-001.md` (reproduced
      as all-green; classified no-repro/stale-premise).
- [x] Every gap classified + listed — `punch-list/GAP-001…007.md` (class + severity + collisions).
- [x] Package exists on disk as specified — this `gitdiff-audit/` tree.
- [x] Verdict posted — this file + the chat report.
- [x] Roadmap reconciled — `skipped-roadmap.md` (PR-2/2b done; overlap with the Changes panel;
      one-line roadmap edit proposed, not applied per diagnose-only + feat-branch policy).

## Scope note (where this package should live)
Per CLAUDE.md doc-lifecycle, a review/audit package normally lands under
`docs/reviews/<date>-…/`, not the repo root. This tree is at `gitdiff-audit/` because the goal's
output contract names that exact path. Recommend relocating to
`docs/reviews/2026-06-23-gitdiff-audit/` if it is to be committed.
