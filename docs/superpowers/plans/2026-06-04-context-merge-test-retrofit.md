# feat/context — catch-up merge + test retrofit to TESTING.md

**Date:** 2026-06-04 · **Branch:** `feat/context` · **PR:** #39
**Goal:** Catch feat/context up to main's T0–T5 testing overhaul and bring ALL of the
branch's tests into conformance with `docs/testing/TESTING.md` (full decision-rule audit).

## Why
feat/context forked at `2d07fbb`, before the testing overhaul. main landed: Playwright
`_electron` e2e, deletion of the `CANVAS_SMOKE=e2e` harness, the vitest unit/integration
project split, and `docs/testing/TESTING.md`. The branch's tests pre-date all of it:
6 Context probes hung off the now-deleted harness, and its IPC tests use bespoke fakes
instead of the standard `ipcTestHarness`.

## Decision-rule recap (TESTING.md)
- `*.test.ts` = **unit** (pure fn + mocked collaborators, node). `*.test.tsx` = jsdom.
- `*.integration.test.ts(x)` = **integration** (rendered tree / registered IPC handler /
  `electron` mocked). MAIN-IPC handlers → integration via `src/main/ipcTestHarness.ts`
  (`createIpcCapture` / `invoke` / `invokeAs`). **Foreign-sender rejection REQUIRED for
  every guarded handler** (checklist #17/#20).
- **e2e** = Playwright `_electron`, real app, native layer only. **Context subsystem
  mandatory e2e slivers = NONE** — all its logic is unit/integration-provable.

## Phase 1 — catch-up merge  ✅ DONE (`3995b67`)
- `git merge origin/main`; 2 conflicts.
- `src/main/e2e/*` (modify/delete) → took main's deletion; deleted the 6 orphaned probes
  (content in git history at `origin/feat/context:src/main/e2e/probes/*.ts`).
- `src/main/projectIpc.test.ts` (content) → took main's re-tiered base.
- Verified: typecheck + lint clean, 824 unit/integration tests green.

## Phase 2 — retrofit to conformance  ✅ DONE
Outcome: 833 unit+integration tests green, typecheck + lint clean. IPC tests re-tiered onto
`ipcTestHarness`; the dead `CANVAS_SMOKE` mock-seam coupling removed from production +
tests; all 6 deleted-probe assertions confirmed covered at unit/integration (read-only audit);
one gap (preload `api.llm.*` contract) closed.

### 2a. Re-tier the IPC tests
- [ ] `llmIpc.test.ts` → `llmIpc.integration.test.ts`. Replace the bespoke `fakeIpc()` with
  `createIpcCapture()` from `ipcTestHarness.ts`. Keep the `isForeignSender` cases; assert
  **foreign-sender rejection via `invokeAs(foreignEvent, …)` for every guarded `llm:*`
  handler**. Mock the LLM service / fs collaborators (no network, no real disk).
- [ ] Re-home feat/context's projectIpc cases (in history at
  `origin/feat/context:src/main/projectIpc.test.ts`, the 296-line version): IPC-handler
  cases → `projectIpc.integration.test.ts`; any pure cases → `projectIpc.test.ts`. Add
  foreign-sender rejection for any new context-related guarded project handler.
- [ ] Same pass for any other new guarded MAIN handler the Context feature added
  (memory IPC, key-store IPC) → integration + foreign-sender.

### 2b. Probe coverage audit (push-down, then confirm deletion stands)
For each deleted probe, confirm its assertion exists at unit/integration; add it if not.
| Probe (history) | Asserts | Target test | Status |
|---|---|---|---|
| `context-digest` / `context-brain` | digest build + LLM brain | `digest.test.ts`, `llmService.test.ts` | [ ] confirm |
| `context-budget` | cap enforcement (+ DOM digest cards) | `llmBudget.test.ts`; DOM → `DigestPanel`-style integration if missing | [ ] confirm/add |
| `context-change` | meaningful-change detect + debounce | `memoryEngine.test.ts` | [ ] confirm |
| `context-memory` | storage disk layer | `canvasMemory.test.ts` | [ ] confirm |
| `context-keystore` | safeStorage key never returned to renderer | `llmKeyStore.test.ts` | [ ] confirm key-isolation asserted |
| `context-summary` | Tier-2 loop over real canvas.json | `summaryLoop.test.ts` | [ ] confirm |

### 2c. Full decision-rule audit (every feat/context feature module)
Walk each module the branch added/changed; ensure logic is covered at the correct tier
per the rule (not just where a probe existed). Modules: `llmService`, `llmConfig`,
`llmKeyStore`, `llmBudget`, `llmIpc`, `memoryEngine`, `canvasMemory`, `summaryLoop`,
`digest`, `projectStore`/`projectIpc` deltas, plus any renderer Context UI (digest panel,
settings). Component render tests → `*.integration.test.tsx` (jsdom). Pure helpers → unit.
- [ ] Produce a per-module coverage line; add missing tier coverage.

## Phase 3 — verify + ship
- [ ] `pnpm typecheck` · `pnpm lint` · `pnpm test` (both projects green).
- [ ] `pnpm test:e2e` (Windows leg) — confirm NO Context e2e remains and the keep-set is green.
- [ ] Run the full pre-commit matrix (`pnpm test:e2e:matrix`, Docker up) before push.
- [ ] Update `docs/context/*` gate table; push; PR #39 reflects the catch-up + retrofit.

## Risks
- Deleting a probe before confirming coverage = silent loss → 2b gates deletion (already
  deleted in Phase 1, so 2b is a *confirm-or-restore-as-lower-tier* audit, not blind).
- Missing foreign-sender test on a new guarded handler = guideline + real security gap
  (Host-header attack class). 2a makes it mandatory.
