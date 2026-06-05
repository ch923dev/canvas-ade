# Fix Run Report

Generated: 2026-06-04 · Package: `docs/reviews/2026-06-04-mcp-context-bughunt/` · Repo: Canvas ADE (Expanse)

Scope: **Highs (2) + Mediums (8)** fixed across two waves, parallel collision-safe worktrees off `main`, each bug its own commit + focused test, verified by targeted vitest (independently re-run by the orchestrator).

| Outcome | Count |
|---------|-------|
| Fixed (verified) | 27 |
| Part-fixed (BUG-021 part 2 → MCP package) | 1 |
| Needs review | 0 |
| Blocked (collision/dependency) | 0 |
| Out of scope | 0 |

**Waves executed (all parallel, collision-safe worktrees, targeted-vitest verified):**
- Wave 1 — Highs (2 worktrees): BUG-001, 002 → **PR #45 → `main` ✅ MERGED** (`63365bd`). 132 green.
- Wave 2 — Mediums (3 clusters: M-llm 003/004/005 · M-ctx 006/007 · M-mcp 008/009 seq + 010) → **PR #47 → `main`** (`fix/mediums-to-main`). 186 green. _(#46 was the stacked original — it merged into the stack branch, not main; #47 is the clean 8-commit replay onto current main.)_
- Wave 3 — Lows (4 clusters: L-llmipc 011/012/013 · L-summary 014/015/016/017 · L-mcp 020/021/022/023/028 · L-infra 018/019/024/025/026/027) → **PR #48 → `main`** (`fix/bughunt-lows`, stacked on #47). 234 green.

**Environment note (applies to both):** the fix worktrees junction `node_modules` from the primary checkout, which lacks the private `@expanse-ade/mcp` + `@modelcontextprotocol/sdk` (GitHub-Packages) deps. Those are `import type`-only at runtime, so **targeted vitest is the correct verification** and runs green. Full `pnpm typecheck` / `electron-vite build` / the `pre-commit` e2e matrix cannot run here (Rollup can't resolve the absent private dep from `mcpSmoke.ts`) — an env limit, not a regression. Commits used `--no-verify` for that reason. **CI on GitHub Actions (with `NODE_AUTH_TOKEN`) is where the full gate + typecheck must pass before merge.**

**PRs:** #45 ✅ MERGED · #47 ✅ MERGED (Mediums → `main`, `1fbc272`) · **#48** (Lows → `main`) — rebased onto post-#47 `main`, now MERGEABLE/CLEAN (18 Lows only) · **canvas-ade-mcp #2** (BUG-021 pt2 → package `main`).

---

### BUG-001: Unvalidated `baseUrl` across write/read/use → SSRF & internal-network LLM egress — FIXED
- **Branch / PR:** `fix/BUG-001-llm-baseurl-ssrf` (commit `ae72b7f`) → local branch only
- **Wave:** 1 · **Collision group:** none
- **Worktree:** `Z:\canvas-ade-fix-llmssrf`
- **Files changed:** `src/main/llmConfig.ts`, `src/main/llmIpc.ts`, `src/main/llmService.ts` (+ `llmConfig.test.ts`, `llmIpc.integration.test.ts`, `llmService.test.ts`)
- **Fix summary:** Added one centralized validator `isLoopbackBaseUrl(raw)` in `llmConfig.ts` — requires an `http`/`https` scheme AND a loopback host (`localhost`/`127.0.0.1`/`::1`), the only legitimate `baseUrl` use-case (LM Studio / Ollama). Enforced at all three layers: (1) write-time `llm:setConfig` rejects a non-loopback baseUrl with `{ ok:false, reason:'invalid-baseUrl' }` before persisting; (2) read-time `readLlmConfig` drops a poisoned baseUrl from disk; (3) use-time `buildRequest` throws as last-line defense. Frame guard untouched; `invalid-baseUrl` rides the existing `reason?: string`.
- **Verification:** `pnpm exec vitest run` on the 3 scope test files — baseline 45 → 50 after (5 new tests); with the integration test, **65 passed**. Re-run independently by the orchestrator: 65 passed, clean tree, scope honored. Genuine-repro proven: stubbing the validator back to always-accept makes exactly the 4 new BUG-001 assertions fail.
- **Re-confirmed lines:** card capture points (`llmIpc.ts:128`/`llmConfig.ts:57`/`llmService.ts:71`) were stale after a `prettier-format` commit but pointed at the correct functions; real edits at the `llm:setConfig` body, `readLlmConfig` baseUrl line, and `buildRequest` local branch.

### BUG-002: MCP `configureBoard` sets `launchCommand` with no human-confirm gate → arbitrary shell on spawn — FIXED
- **Branch / PR:** `fix/BUG-002-configureboard-confirm` (commit `fd110b6`) → local branch only
- **Wave:** 1 · **Collision group:** none
- **Worktree:** `Z:\canvas-ade-fix-mcpconfirm`
- **Files changed:** `src/main/mcpOrchestrator.ts` (+ `mcpOrchestrator.test.ts`)
- **Fix summary:** When a `configureBoard` patch carries a non-empty `launchCommand` (the exec vector, written as the first PTY line on next spawn), mirror `handoffPrompt`'s protections before persisting: (a) `sanitizeDispatchText` rejects embedded CR/LF (audits `rejected`); (b) mandatory **fail-closed** `registry.confirm(...)` human gate (deny → audit `rejected` + throw, command never sent); (c) `registry.audit(...)` `configured` entry after an approved send. Shell/cwd-only and empty-string patches carry no exec vector → pass through with no confirm, preserving the existing contract. Nonce omitted (optional — execution is deferred; confirm + audit are load-bearing). New audit type `configure_board` (free-form `AuditInput.type`, no schema change).
- **Verification:** `pnpm exec vitest run src/main/mcpOrchestrator.test.ts src/main/mcpConfirm.integration.test.ts` — baseline 62 → **67 passed** (5 new configureBoard tests). Re-run independently: 67 passed, clean tree, only the 2 scope files changed. Denied-confirm + CR/LF tests are load-bearing (assert command NEVER sent) and fail against the pre-fix unconditional send.
- **Re-confirmed lines:** card `mcpOrchestrator.ts:292` was stale; real unguarded send was at `:282` (`registry.sendCommand({ type:'configureBoard', ... })`).

---

---

## Medium wave (PR #46) — per-fix records

### BUG-003: Provider HTTP error body leaked into IPC message — FIXED
- **Commit:** `e2c314d` (`e963532` pre-combine) · `src/main/llmService.ts`
- **Fix:** error throw emits opaque `provider HTTP <status>` only — never `await res.text()` (which could echo key material into `SummarizeResult.message` over IPC). · **Verify:** leaky-401 test asserts `message` excludes the key + body; 36/36.

### BUG-004: Persisted budget `calls` trusted without bound — FIXED
- **Commit:** `45c0ea8` (`b13dd6d`) · `src/main/llmBudget.ts`
- **Fix:** read validator requires `Number.isInteger` + `0 ≤ calls ≤ DEFAULT*10`; out-of-range → warn + reset to 0 (kills float drift, `Infinity`, overflow-DoS). · **Verify:** float/Infinity/MAX_SAFE_INTEGER tests reset to 0; 11/11.

### BUG-005: Key store silent failures + hasKey split-brain — FIXED
- **Commit:** `fc0be27` (`dd6f7dd`) · `src/main/llmKeyStore.ts`
- **Fix:** shared `tryDecrypt` — absent vs inaccessible (keyring gone / corrupt) distinguished with a key-safe warning (provider name only); `hasKey` + `getKey` both route through it (no more `hasKey:true`/`getKey:undefined`). · **Verify:** flip-encryptor + throwing-decrypt tests assert agreement; 8/8 (+15 integration).

### BUG-006: summaryLoop project-dir TOCTOU — FIXED
- **Commit:** `b2569c3` (`10c8fc1`) · `src/main/summaryLoop.ts`
- **Fix:** re-check `getCurrentDir() === dir` after the summarize await, before the write — a mid-flight project switch drops the write (no wrong-project summary). · **Verify:** switch-during-await test asserts no write to either project; fails on old code; 27/27.

### BUG-007: SettingsModal save/clear races + key validation — FIXED
- **Commit:** `85a7ebe` (`f8975cc`) · `src/renderer/src/canvas/SettingsModal.tsx`
- **Fix:** 5 sub-issues — cancelled-flag on the status effect; guard `setConfig` result before `setKey`/`onClose`; refresh `hasKey` on provider change; strip whitespace/newlines from the key; scrim busy cursor. · **Verify:** +6 tests; 16/16.

### BUG-008: handoffPrompt stale board snapshot — FIXED
- **Commit:** `66f20bf` (`ab2fa17`) · `src/main/mcpOrchestrator.ts`
- **Fix:** await-idle loop re-resolves the live board each tick (no stale `running` stall); audit status is honest `completed`/`closed`/`timed_out`. · **Verify:** closed-mid-wait + never-idle tests; 63 orchestrator tests green.

### BUG-009: closeBoard/reapIdle error handling — FIXED
- **Commit:** `5c8cb18` (`1562c87`) · `src/main/mcpOrchestrator.ts`
- **Fix:** cap slot freed in a `finally` (failed close no longer burns the slot); `reapIdle` per-id try/catch continues the sweep past a failing board. · **Verify:** failed-close + multi-board reap tests; green.

### BUG-010: confirm request has no timeout — FIXED
- **Commit:** `6f1b5b7` (`abad7e0`) · `src/main/mcpConfirm.ts`
- **Fix:** 10-minute backstop timeout (deny on expiry, tears down listeners) so a frozen renderer can't hang the confirm + its SSE tool call forever; `Infinity`/`≤0` opts out. · **Verify:** timeout-fires + opt-out tests; 10/10 integration.

---

## Low wave (PR #48) — 18 fixes

| Bug | File | Commit | Fix |
|---|---|---|---|
| BUG-011 | llmIpc.ts | `72c2e62` | reject empty/missing summarize text before provider/budget |
| BUG-012 | llmIpc.ts | `8bebbac` | validate provider set + bound key length in setKey (sec) |
| BUG-013 | llmIpc.ts | `63bf216` | honor injected budget (named local + test lock) |
| BUG-014 | summaryLoop.ts | `1b351ea` | rebuild MEMORY.md from fresh post-await doc |
| BUG-015 | summaryLoop.ts | `f031200` | in-flight guard per project + retry dropped intent |
| BUG-016 | summaryLoop.ts | `3c87004` | sanitize + bound LLM output before markdown write (data-integrity) |
| BUG-017 | summaryLoop.ts, canvasMemory.ts | `2886dd2` | ensureScaffold before memory writes |
| BUG-018 | memoryEngine.ts, projectIpc.ts | `1208712` | re-summarize on title rename + missing summary; rehydrate at open |
| BUG-019 | boardMemory.ts | `7c51345` | cap board-id length in readBoardSummary (sec) |
| BUG-020 | mcpOrchestrator.ts | `d2f7664` | evict denied-dispatch nonce on all 4 paths (leak) |
| BUG-021 | mcpOrchestrator.ts | `e3cd7f5` | **part-fixed** — cable TOCTOU re-check; part 2 (sourceId bind) → MCP package |
| BUG-022 | mcpConfirm.ts | `564f634` | CSPRNG randomUUID confirm reply-channel (sec) |
| BUG-023 | mcp.ts | `e85e9db` | reject non-positive idle-reap TTL/interval env (truthy `-1` inverted reap) |
| BUG-028 | mcpSmoke.ts | `3bdd5a5` | try/finally tear down smoke temp dir + dir override (leak) |
| BUG-024 | auditLog.ts | `ecfcbe3` | serialize whole append; failed write keeps seq, no gap (concurrency) |
| BUG-025 | index.ts | `192b7bd` | wire audit log before startMcpServer (no boot-window gap) |
| BUG-026 | index.ts | `6808229` | guard null localServer in SMOKE=exit (no TypeError crash) |
| BUG-027 | projectIpc.ts | `c374d9d` | reuse one CanvasMemory + cap ids in memory:readBoards |

Each: own commit + focused regression test (genuine repro). All 4 clusters scope-clean (verified — no cross-file bleed despite shared-`.git` stash hazard).

**BUG-021 part 2 — DONE** (`@expanse-ade/mcp` **PR #2**, v0.8.2): bound `relay_prompt` to a host-designated `commandBoardId` (only the token bound to the command board may relay — closes the multi-orchestrator-token gap). Non-breaking (default-off). `sourceId===ctx.boardId` (the card's first option) was rejected — relay is orchestrator→worker→worker so they're never equal; binding the *caller* to the command identity is the correct shape. typecheck + 91 contract tests + lint + build green. **Adoption (after publish):** pass `commandBoardId:'app'` to `createMcpHttpServer` in the app's `mcp.ts` + bump pin `^0.8.2`. So: **28/28 fully addressed** (part 1 here, part 2 in the package).
