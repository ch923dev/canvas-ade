# Fix Report — 2026-07-02 Bug-Hunt Expedition

**Outcome:** 57 / 57 confirmed bugs fixed, verified, and merged into the local integration branch
`integ/cumulative` (tip `da6e7b55`). **Nothing pushed. `main` untouched.**

## Method

Each bug fixed by a dedicated Claude Code subagent in its OWN isolated git worktree (forked from
`main`), on a `fix/BUG-NNN-<slug>` branch, one commit per bug, minimal-scope. Run in 5 parallel
waves. Every branch merged one-by-one into `integ/cumulative`; conflicts (where two fixes touched
the same lines) reconciled centrally to preserve BOTH intents. Central verification run on the
assembled integ after each wave.

## Central verification (final, full 57-fix integ)

| Check | Result |
|---|---|
| `pnpm typecheck` (node + preload + web) | ✅ clean |
| `pnpm lint` | ✅ 0 errors (37 pre-existing token-drift **warnings**, unchanged) |
| `pnpm format:check` | ✅ clean (src + config; the only flagged file is the local gitignored `.impeccable/hook.cache.json`, absent in CI) |
| `pnpm test` (unit + integration) | ✅ **4064 passed · 1 skipped · 301 files** |
| e2e (`pnpm test:e2e`) | ⏳ not run — it is the pre-push gate; run it before any push (see Landing). |

## Waves

- **Wave 1–2** (card-driven, before the data-loss incident) + **Wave 3** (INDEX-driven): the first
  ~33 fixes.
- **Wave 4** (10): BUG-007, 013, 018, 020, 025, 033, 035, 041, 047, 052.
- **Wave 5** (14): BUG-008, 021, 023, 026, 027, 030, 034, 040, 042, 043, 044, 049, 056, 057.

## Merge-time reconciliations (both intents preserved)

| Files | Fixes reconciled | Resolution |
|---|---|---|
| `canvasStore.ts` (+ pin) | BUG-006 ↔ BUG-007 | Ported 006's four untracked layout writers onto 007's per-gesture `pendingCheckpoints` stack (`rewritePendingBoards`). max-lines pin 718→720. |
| `cliProvisioners/claude.ts` + `provisioners.test.ts` | BUG-020 ↔ BUG-023 | Kept 020's `originalMcp` rollback capture AND 023's validated `existingServersMap` spread; kept all three tests. |
| `index.ts` | BUG-024 ↔ BUG-026 | Kept the queue rename (`pendingDeepLinks: string[]`) AND the BUG-024 entitlement-TTL block. |
| `terminalSnapshot.ts` | BUG-012 ↔ BUG-040 | Took 040's `resolveWriteTarget` helper + sync/async split; preserved 012's delete-stale-sidecar-on-oversized inside the resolver. |
| `platformIpc.ts` | BUG-045 ↔ BUG-057 | Kept both imports; **frame-guarded 057's new `platform:e2eEnabled` handler** to honor 045's invariant (foreign sender → `false`). |

## Scrutiny passes

- **BUG-035** (flagged "scope may be off-target") — verified renderer-side only
  (`useOffscreenInput.ts`, gates on `useOsrLivenessStore`); does NOT touch `previewOsr.ts`. ✅
- **BUG-024** (flagged "scrutinize scope") — no scope creep; consumes the pre-existing orphaned
  `isFresh()`, fail-closed guards, 1h TTL. ✅

## Notes to carry forward

- **BUG-027 / BUG-057 touch build wiring** (`electron.vite.config.ts` `__ENABLE_E2E_MAIN__` define,
  `package.json` e2e script, `Dockerfile.e2e`, MAIN→preload `platform:e2eEnabled`). Unit gate is
  green, but the e2e BUILD path is exercised only by `pnpm test:e2e` — run the full e2e matrix
  before merging these to `main`.
- **Data loss:** a Wave-3 agent's `git clean` in MAIN wiped untracked files (this package's card
  bodies 002–057 + other-session `DESIGN.md`, `PRODUCT.md`, Meridian `redesign/` handoff). Fixes
  unaffected. The lost other-session files need owner re-creation. Prompt hardened afterward.

## Landing (open decision)

Everything is local: 57 `fix/BUG-NNN-*` branches + `integ/cumulative`. Options:
1. Keep as local branches (current state).
2. Push + one PR per bug (57 PRs) — heavy but matches the "one bug per PR" contract.
3. Push `integ/cumulative` as a single umbrella PR — needs the full e2e matrix green first.

Worktree cleanup pending: 14 Wave-5 `wf_f52c1ffe-*` + 10 Wave-4 `wf_42907a0b-113-*` worktrees still
on disk (`git worktree prune` / `remove-worktree.ps1` after branches are dispositioned). The 3
other-session worktrees (billing / board-inspector / mcp-audit) are NOT part of this run.
