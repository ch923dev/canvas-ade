# gitdiff — gaps the roadmap already covers (skipped / annotated)

Reconciled against `docs/research/2026-06-15-command-board/{README,phase-c-plan,orchestrator-followups}.md`
and `docs/feature-proposals.md`.

## Already DONE on the roadmap (no new gap)
- **PR-2 (`gitDiff` app-side, simple-git in MAIN)** — `README.md:142` marks it DONE (merged into
  umbrella #164). Matches the shipped, green implementation. ✅
- **PR-2b (`git_diff` MCP *tool* in `@expanse-ade/mcp`)** — `README.md:143` marks it DONE, shipped
  `0.11.0`, with "app-pin bump deferred". The app now pins `@expanse-ade/mcp@^0.13.0` (installed
  0.13.0), so the pin caveat is **satisfied** and the tool is registered + routed to
  `orchestrator.gitDiff`. → The *feature* is covered; only the **stale in-repo comments + missing
  over-the-wire test** remain → tracked as **GAP-004** (not skipped, because the code/docs still
  misstate it).

## Covered by a SEPARATE planned feature (skip from this feature's punch-list, but note overlap)
- **GAP-001 (untracked files) + GAP-003 (exact diffstat) + GAP-006 (per-agent scope)** partially
  overlap the proposed **"Changes" panel on each Terminal board** (`docs/feature-proposals.md:390`)
  — "a collapsible Changes panel … showing the live git diff/stat of that [board] … correct file
  list + hunks vs base; expanding a hunk matches `git diff`; discard reverts one file." That
  proposal is the natural home for full file lists (incl. untracked), exact per-file numstat, and a
  base-relative diff.
  - **Why still a gap today:** the *current* result-zone feature ships now and under-reports
    untracked work + miscounts certain lines regardless of that future panel. The punch-list cards
    offer a small in-scope mitigation (label/limited-untracked/hunk-aware parse) so the shipped
    feature is honest before the bigger panel lands. If the team prefers, fold GAP-001/003/006 into
    the Changes-panel spec and downgrade them here — but do not leave them silently unaddressed.

## Not on any roadmap (genuinely new — keep on the punch-list)
- **GAP-002** (clamp doesn't bound MAIN memory) — no roadmap item; resource/security gap.
- **GAP-005** (real-git + rendered-consumption test coverage) — no roadmap item.
- **GAP-007** (no timeout/abort) — no roadmap item.

## Proposed roadmap edit (one line, factual status reconciliation)
In `docs/research/2026-06-15-command-board/README.md:143`, the PR-2b line's parenthetical
"(app-pin bump deferred)" is now stale — the app pins `^0.13.0`. Suggest:
`PR-2b … DONE — shipped 0.11.0 (app-pin landed: ^0.13.0)`.
> Not applied here (audit is diagnose-only, and per CLAUDE.md feature-doc edits belong on the
> feature's worktree, not `main`). Left as a one-line instruction for the fix-runner / next session.
