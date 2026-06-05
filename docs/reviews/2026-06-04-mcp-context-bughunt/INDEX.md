# Bug Hunt Findings — Work Queue

Generated: 2026-06-04 · Scope: **post-MCP / post-Context `main`** (Context subsystem + MCP M0–M4) · Target tree: `origin/main`

Method: dynamic workflow — 10 discovery slices → independent adversarial verifier per candidate (default-refute) → roadmap reconciliation. **122 agents, 4.58M tokens.**

**Raw:** 111 candidates → 48 CONFIRMED → consolidated to **28 finding cards**. 63 refuted (`unconfirmed.md`).

> ✅ **Fix status (2026-06-04):** **ALL 28 addressed** — 27 FIXED + 1 part-fixed (BUG-021), across 3 PRs. See `FIX-REPORT.md`.
> - **Highs → PR #45** ✅ MERGED to `main` (`63365bd`): BUG-001, 002. 132 vitest green.
> - **Mediums → PR #47** `fix/mediums-to-main` (base `main`): BUG-003…010. 186 vitest green. _(#46 was the stacked original; merged into the stack branch, not main — #47 is the clean replay.)_
> - **Mediums → PR #47** ✅ MERGED to `main` (`1fbc272`).
> - **Lows → PR #48** `fix/bughunt-lows` → `main` — rebased onto post-#47 main, **MERGEABLE/CLEAN** (18 Lows only). BUG-011…028. 234 vitest green.
> - **BUG-021 pt2 → `canvas-ade-mcp` PR #2** (v0.8.2): relay caller-identity binding. Adopt via `commandBoardId:'app'` + pin `^0.8.2` after publish.
>
> **All 28 addressed.** Remaining: merge #48; publish mcp 0.8.2 + adopt. CI (Actions) is the gate of record — local couldn't run typecheck/build (private GitHub-Packages dep absent).

| ID | Sev | Category | Title | Files | Collides | Roadmap |
|----|-----|----------|-------|-------|----------|---------|
| BUG-001 | High | security | Unvalidated `baseUrl` across write/read/use → SSRF & internal-network LLM egress | `llmConfig.ts`, `llmIpc.ts`, `llmService.ts` | BUG-003, BUG-011, BUG-012, BUG-013 | — |
| BUG-002 | High | security | MCP `configureBoard` sets `launchCommand` with no human-confirm gate → arbitrary shell command on spawn | `mcpOrchestrator.ts` | BUG-008, BUG-009, BUG-020, BUG-021 | partial |
| BUG-003 | Medium | security | Provider HTTP error body echoed into IPC `message` → latent secret/data leak | `llmService.ts` | BUG-001 | — |
| BUG-004 | Medium | data-integrity | Persisted budget `calls` trusted without isFinite/upper-bound → overflow DoS + cap bypass | `llmBudget.ts` | — | — |
| BUG-005 | Medium | security | Key store silent failures: plaintext-on-disk fallback + swallowed decrypt errors | `llmKeyStore.ts` | — | — |
| BUG-006 | Medium | correctness | summaryLoop project-dir TOCTOU → board summary written to the wrong project | `summaryLoop.ts` | BUG-014, BUG-015, BUG-016, BUG-017 | — |
| BUG-007 | Medium | correctness | SettingsModal save/clear races + weak key validation (5 sub-issues, one file) | `SettingsModal.tsx` | — | — |
| BUG-008 | Medium | concurrency | MCP handoffPrompt uses a stale board snapshot / never-idle deadline | `mcpOrchestrator.ts` | BUG-002, BUG-009, BUG-020, BUG-021 | partial |
| BUG-009 | Medium | error-handling | closeBoard / reapIdle error handling: cap-slot leak + reaper aborts mid-sweep | `mcpOrchestrator.ts` | BUG-002, BUG-008, BUG-020, BUG-021 | partial |
| BUG-010 | Medium | resource-leak | MCP confirm request has no timeout → tool call hangs indefinitely | `mcpConfirm.ts` | BUG-022 | partial |
| BUG-011 | Low | error-handling | llm:summarize accepts unvalidated/empty `text` → `content: null` sent to provider | `llmIpc.ts` | BUG-001, BUG-012, BUG-013 | — |
| BUG-012 | Low | security | llm:setKey: no provider-enum check + unbounded key string | `llmIpc.ts` | BUG-001, BUG-011, BUG-013 | — |
| BUG-013 | Low | correctness | registerLlmHandlers silently drops injectedDeps.budget | `llmIpc.ts` | BUG-001, BUG-011, BUG-012 | — |
| BUG-014 | Low | concurrency | summaryLoop stale doc snapshot → MEMORY.md rebuilt from pre-summarize state | `summaryLoop.ts` | BUG-006, BUG-015, BUG-016, BUG-017 | — |
| BUG-015 | Low | concurrency | summaryLoop inFlight guard: summary loss on slow failure + per-board-not-per-project | `summaryLoop.ts` | BUG-006, BUG-014, BUG-016, BUG-017 | — |
| BUG-016 | Low | data-integrity | summaryLoop writes unsanitized LLM output into a Markdown board summary | `summaryLoop.ts` | BUG-006, BUG-014, BUG-015, BUG-017 | — |
| BUG-017 | Low | correctness | Missing ensureScaffold() before board-memory writes (summaryLoop + canvasMemory) | `canvasMemory.ts`, `summaryLoop.ts` | BUG-006, BUG-014, BUG-015, BUG-016 | — |
| BUG-018 | Low | correctness | memoryEngine: title change no re-summarize + no emit after reset() | `memoryEngine.ts` | — | — |
| BUG-019 | Low | security | boardMemory: no board-ID length cap on filename construction | `boardMemory.ts` | — | — |
| BUG-020 | Low | resource-leak | dispatchGuard outstanding-nonce set grows unbounded on denied/failed dispatch | `mcpOrchestrator.ts` | BUG-002, BUG-008, BUG-009, BUG-021 | partial |
| BUG-021 | Low | security | relayPrompt TOCTOU: connector not re-checked + sourceId not verified as caller | `mcpOrchestrator.ts` | BUG-002, BUG-008, BUG-009, BUG-020 | partial |
| BUG-022 | Low | security | Predictable PRNG confirm reply-channel name | `mcpConfirm.ts` | BUG-010 | partial |
| BUG-023 | Low | correctness | mcp.ts env TTL accepts zero/negative → idle-reap silently disabled | `mcp.ts` | — | partial |
| BUG-024 | Low | concurrency | auditLog sequence reset/interleave on concurrent append + restart | `auditLog.ts` | — | partial |
| BUG-025 | Low | correctness | Audit log wired AFTER MCP server starts → early dispatch escapes the trail | `index.ts` | BUG-026 | partial |
| BUG-026 | Low | correctness | Non-null assertion on localServer in SMOKE=exit path → possible null deref | `index.ts` | BUG-025 | — |
| BUG-027 | Low | correctness | memory:readBoards instantiates a new CanvasMemory on every IPC call | `projectIpc.ts` | — | — |
| BUG-028 | Low | resource-leak | mcpSmoke temp dir not cleaned on unexpected throw | `mcpSmoke.ts` | — | — |

**Summary:** 111 candidates → 48 confirmed → 0 skipped to roadmap → **28 in-scope cards** (2 High · 8 Medium · 18 Low · 0 Critical).

**Parallelization:** cards with "—" in *Collides* can be assigned simultaneously. Cards sharing a file must be sequenced (see each card).

**Partials:** 10 cards are partially covered by `docs/roadmap-mcp.md` MCP hardening T-items — kept in-queue, cross-referenced in `partials-roadmap-xref.md`. None were fully covered, so nothing was skipped.

> ⚠️ Line numbers were captured against the `integration/mcp-on-main` worktree (since removed); its `src/` is byte-identical to `origin/main` (the only delta was a docs-only commit). Re-confirm `file:line` on a fresh `main` checkout before editing — surrounding code may have shifted if other PRs landed.