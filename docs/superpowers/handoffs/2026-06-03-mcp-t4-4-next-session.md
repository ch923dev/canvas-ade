# Next-session kickoff — MCP M4 T4.4: `assign_prompt` + `write_result` 🔒

> Paste the block below into the next session. Self-contained. M4 is the most security-sensitive
> milestone — treat every line as an injection vector, TDD-first, no shortcuts.

---

You are continuing the Canvas ADE × MCP integration roadmap. M0+M1+M2+M3 are COMPLETE on
`feat/mcp-integration`, and M4 (Dispatch) cards **T4.1 (audit-log) + T4.2 (confirm-modal) + T4.3
(handoff_prompt, the keystone — first PTY-write tool) are DONE** (squash-merged, pushed). This session:
build **T4.4 — `assign_prompt` (fire-and-forget) + `write_result` (the FIRST worker-tier write tool)**.
Then continue T4.5 → T4.6 SEQUENTIALLY (one card fully green + squash-merged + handed off before the
next). Do NOT parallelize.

⚠️ M4 is the dangerous milestone. Worker-originated content must never auto-trigger a write; the human
confirm always sits between observation and action. TDD-first.

START BY reading the T4.3 closeout: `Z:\canvas-ade-mcp-int\docs\superpowers\handoffs\
2026-06-03-mcp-t4-3-handoff-prompt.md` (commit `8dfa08d`). It records exactly what shipped and the
seams T4.4 reuses. Then read CLAUDE.md (Process model & security), `docs/roadmap-mcp.md` § M4, and the
T4.3 doc's "T4.4" section. Confirm: app worktree `Z:\canvas-ade-mcp-int` on `feat/mcp-integration`; pkg
sibling `Z:\canvas-ade-mcp` on `feat/handoff-prompt` (0.5.0 HELD); `pnpm mcp:link` symlink active.

REPOS / RUNTIME
- App: `Z:\canvas-ade-mcp-int` — branch `feat/mcp-integration`. Cut `feat/mcp-t4-4-assign-write-result`
  off it; squash-merge back when green (`git merge --squash` then `git branch -D` — squash leaves it
  "unmerged"). Worktree node_modules is its OWN (de-junctioned) — normal pnpm, do NOT re-junction.
- Pkg: `Z:\canvas-ade-mcp` — stack `feat/assign-result` off `feat/handoff-prompt` (0.5.0 held tip),
  bump **0.6.0 HELD**. Dev loop = the symlink (app sees pkg edits after `pnpm mcp:build`, no publish).
  package.json/lockfile stay published `^0.2.4` (CI-safe); never commit a `link:` entry. 2 pre-existing
  dirty research docs in the pkg tree are NOT yours — leave them. ⚠️ pkg `tsc` is RED on the base (37
  pre-existing test-orchestrator errors — classes that `implements Orchestrator` directly never got
  closeBoard/configureBoard/handoffPrompt); the pkg gate is `pnpm test` + `pnpm build` + `pnpm lint`,
  NOT typecheck. Don't let it confuse you; optionally fix it (make those test classes
  `extends MockOrchestrator`) but it's out of T4.4 scope.
- App main `Z:\Canvas ADE` — integration only; NEVER work there. Do NOT merge `feat/mcp-integration` to
  app main (user's call). Do NOT publish the pkg or bump the app floor without the user's go-ahead.

WHAT T4.4 BUILDS

**1. `assign_prompt` — fire-and-forget dispatch (make the existing `dispatchPrompt` REAL)**
`Orchestrator.dispatchPrompt(boardId, text): Promise<void>` already exists on the interface and the app
adapter currently THROWS ("not available until Phase 4"). Make it real = the SAME 🔒 gating as
`handoff_prompt` MINUS the blocking await-idle/result:
- pkg (`feat/assign-result`): `constants.ts` `TOOL_ASSIGN_PROMPT = 'assign_prompt'`; new
  `src/server/tools/assignPrompt.ts` `registerAssignPrompt(server, orchestrator)` (orchestrator-tier
  ONLY, register inside the `ctx.tier === 'orchestrator'` block in `factory.ts`, like handoff_prompt);
  input `{ boardId: z.string().min(1), prompt: z.string().min(1) }`; calls `orchestrator.dispatchPrompt`;
  returns a short ack text. Contract test (tier split + forward + empty-id/prompt reject). Template:
  `src/server/tools/handoffPrompt.ts`.
- app (`mcpOrchestrator.ts`): replace the `dispatchPrompt` throw with the real flow (TDD with the fake
  registry): (1) resolve opaque id via `listBoards()` — not found → audit `rejected` + throw; (2)
  terminal-only → reject + audit; (3) `guard.issue()`; (4) `requestConfirm` (resolved target + exact
  prompt; deny → audit `denied` + throw, NO write); (5) `guard.consume` (defensive); (6)
  `writeToPty(text+'\r')` (false → audit `failed` + throw); (7) audit `dispatched` and RETURN (no
  await-idle, no result — fire-and-forget). Reuse the SAME `dispatchGuard` + `writeToPty` + `confirm` +
  `audit` already on `BoardRegistry`. The unit test that asserts `dispatchPrompt` rejects with /Phase 4/
  must be REPLACED with real assign tests (mirror the handoff ones minus await-idle/result).
- `index.ts` needs NO new wiring (the registry already injects writeToPty/confirm/audit).

**2. `write_result` — the FIRST worker-tier write tool**
A worker records its OWN board's structured result → feeds `canvas://board/{id}/result` (T1.5). The app
already has `recordBoardResult` / `readBoardResult` in `src/main/boardResults.ts` (the smoke + T1.5 probe
use them).
- pkg: `constants.ts` `TOOL_WRITE_RESULT = 'write_result'`; `Orchestrator.writeResult(boardId, result:
  { status?, summary?, refs? }): Promise<void>` on the interface + a no-op `MockOrchestrator` impl; new
  `src/server/tools/writeResult.ts` `registerWriteResult(server, orchestrator, ctx)` — register it
  OUTSIDE the orchestrator-only block (the worker tier MUST be able to call it; the FIRST worker write).
  🔒 BIND TO `ctx.boardId` (the worker's own bound board), NOT a client-supplied id — a worker must not
  forge ANOTHER board's result. Input = the result fields only `{ status?, summary?, refs? }` (NO
  boardId). Calls `orchestrator.writeResult(ctx.boardId, {...})`. No PTY write, no confirm (the agent is
  reporting its own outcome, not dispatching). Contract test: BOTH tiers list/call it (or at least the
  worker tier can); it forwards the bound boardId + fields.
- app (`mcpOrchestrator.ts`): implement `writeResult(boardId, result)` → `registry.recordResult(boardId,
  {...})`; extend `BoardRegistry` with injected `recordResult` (MAIN injects `recordBoardResult` from
  `boardResults.ts`); wire it in `index.ts`. (No audit needed — it's not a PTY write; but you MAY audit
  for completeness.) TDD with the fake registry.

SAFETY INFRA (T4.1/T4.2/T4.3 — consume, don't rebuild)
- `dispatchGuard.ts` (single-use nonce + monotonic seq), `pty.ts` `writeToPty` (MAIN-only, sessions-keyed
  = terminal-only), `mcpConfirm.ts` `requestConfirm` (fail-closed), `auditLog.ts`/`auditIpc.ts`
  (`getAuditLog().append`). `BoardRegistry` already carries `writeToPty`/`confirm`/`audit`.

SECURITY (never weaken)
- `assign_prompt` = orchestrator-tier only, same gating as handoff (human confirm mandatory, nonce,
  terminal-only, opaque id, audit). `write_result` = worker-tier write, but bound to the worker's OWN
  `ctx.boardId` (no cross-board forge), no PTY/confirm. node-pty MAIN-only; don't weaken
  contextIsolation/sandbox/nodeIntegration; commands/confirm stay frame-guarded. Do NOT unblock
  `gitDiff` (M6). The smoke MUST assert: a worker is DENIED `assign_prompt`/`handoff_prompt` (and every
  orchestrator tool) AND a worker CAN call `write_result` (the tier split now cuts both ways).

CADENCE (mandatory)
- TDD every pure/decidable unit FIRST (watch it fail). Gate before handoff (the REAL gate = `check`):
  `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build`. Then both smokes:
  `CANVAS_SMOKE=mcp pnpm start` (→ `MCP_ASSIGN_OK` + `MCP_WRITE_RESULT_OK` … `MCP_DONE`) AND
  `CANVAS_SMOKE=e2e pnpm start` (`E2E_DONE`; the preview/connector/fullview trio is a known
  contended-host flake — rerun for clean, memory `e2e-browser-trio-flake`; e2e is FROZEN in CI, `check`
  is the gate). pkg: `cd Z:\canvas-ade-mcp; pnpm test`.
- One app sub-branch + matching stacked pkg `feat/*` (0.6.0 HELD) → squash-merge app branch back when
  green → push umbrella → write `docs/superpowers/handoffs/2026-06-03-mcp-t4-4-assign-write-result.md`.
- Update YOUR row on `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` BEFORE editing. ⚠️ CROSS-ZONE:
  `src/main/index.ts` + `src/preload/index.ts` + `App.tsx` also touched by `feat/context` (additive, no
  shared lines).

THEN T4.5 → T4.6 (same cadence): T4.5 `interrupt(boardId)` (orchestrator-tier; send `'\x03'` to the
target PTY, terminal-only; `drainPty` already writes `'\x03'`) + same nonce/confirm/audit gating. T4.6
agent-to-agent over the M2 orchestration connector cable (resolve target from the edge; 🔒
terminal→terminal only, one-directional, never Browser→PTY).

🚦 M4 gate: a confirmed, audited, nonce-protected prompt executes in the target terminal (assign +
handoff); a worker tier is denied every dispatch tool but CAN `write_result`; tainted worker content can
trigger nothing without the human gate — both `CANVAS_SMOKE=mcp` and `CANVAS_SMOKE=e2e` green.
