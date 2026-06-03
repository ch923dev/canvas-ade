# Handoff — MCP M4 T4.4 `assign_prompt` + `write_result` SHIPPED → next: T4.5 `interrupt` 🔒

> **M4 (Dispatch) is sequential (🔒 T4.1→T4.6).** **T4.1 audit · T4.2 confirm · T4.3 handoff_prompt ·
> T4.4 assign_prompt + write_result are DONE** (squash-merged onto `feat/mcp-integration`, pushed).
> This doc closes **T4.4** and sets up **T4.5**. M4 is the most security-sensitive milestone — TDD-first.

## What T4.4 shipped

- **App umbrella `feat/mcp-integration`** (pushed `819045f`): squash of `feat/mcp-t4-4-assign-write-result`
  (sub-branch deleted). **pkg sibling `Z:\canvas-ade-mcp`** is on **`feat/assign-result` (0.6.0, HELD/
  unpublished, `5cd49e9`)** stacked off `feat/handoff-prompt`. Dev loop = the `pnpm mcp:link` symlink
  (app sees the tools live after `pnpm mcp:build`; app floor stays published `^0.2.4`, CI-safe).

### `assign_prompt` — fire-and-forget dispatch (the existing `dispatchPrompt`, made real)
- **pkg (0.6.0):** `TOOL_ASSIGN_PROMPT`; `src/server/tools/assignPrompt.ts` (`registerAssignPrompt`,
  input `{boardId, prompt}` both `.min(1)`, calls `orchestrator.dispatchPrompt`, returns a short ack)
  registered **inside the `ctx.tier === 'orchestrator'` block** in `factory.ts` (structural split).
  Contract test `test/contract/assignPrompt.contract.test.ts` (tier split + forward + empty-id/prompt reject).
- **app `src/main/mcpOrchestrator.ts`:** `dispatchPrompt` flow — the SAME 7-step gating as `handoffPrompt`
  **minus** the blocking await-idle/result: (1) resolve by **opaque id** via the board mirror, (2)
  **terminal-only**, (3) `guard.issue()`, (4) `requestConfirm` (deny → audit `denied` + throw, NO write),
  (5) `guard.consume` (defensive), (6) `writeToPty(text+'\r')` (false → audit `failed` + throw), then
  **audit `assign_prompt` `dispatched` at write time and RETURN** (no `completed`, no poll). The old unit
  test asserting `dispatchPrompt` rejects with `/Phase 4/` was REPLACED with 7 real assign tests.

### `write_result` — the FIRST worker-tier WRITE tool
- **pkg:** `TOOL_WRITE_RESULT`; `Orchestrator.writeResult(boardId, result: BoardResultInput): Promise<void>`
  on the interface (+ `BoardResultInput` type, exported; `MockOrchestrator` no-op); `src/server/tools/
  writeResult.ts` (`registerWriteResult(server, orchestrator, ctx)`, input `{status?, summary?, refs?}` —
  **NO boardId**) registered **OUTSIDE** the orchestrator-only block (BOTH tiers). 🔒 **Bound to
  `ctx.boardId`** (the caller's token board), so a worker can only write its OWN result — never forge
  another's. `test/helpers/inMemory.ts` gained an optional `boardId` arg for the binding tests; contract
  test `test/contract/writeResult.contract.test.ts` (both tiers list it · binds ctx.boardId · forge
  ignored · forwards fields · minimal-empty).
- **app `src/main/mcpOrchestrator.ts`:** `writeResult(boardId, result)` → stamps `present:true` + `at`
  (`new Date(now()).toISOString()`, injectable clock), carries only supplied fields → `registry.recordResult`.
  `BoardRegistry` gains injected **`recordResult`**; `src/main/index.ts` injects `recordBoardResult` from
  `boardResults.ts` (feeds `canvas://board/{id}/result`, T1.5). No PTY write, no confirm.
- **app `src/main/mcpSmoke.ts`:** **MCP_ASSIGN_OK** (tier split, worker DENIED server-side, non-terminal
  rejected, confirm-driven happy path lands in the PTY, fire-and-forget resolves with no `setTerminalDown`)
  + **MCP_WRITE_RESULT_OK** (write_result in BOTH lists; a worker records its own result, bound to
  `smoke-worker`, and `canvas://board/smoke-worker/result` reflects it). Self-skip on a pkg < 0.6.0.
- **app `src/main/e2e/probes/dispatch.ts`:** **`dispatch-assign`** (REAL seams against a live terminal —
  label rejected; confirm → write → PTY land → resolves with NO await-idle; `dispatched` audited + NO
  `completed`; forged nonce writes nothing; baseline 4) + **`dispatch-write-result`** (adapter `writeResult`
  → `readBoardResult` reflects `present:true` + fields + `at`). Both added to the playlist after `dispatch-handoff`.

**Security:** assign reuses every handoff invariant (authority = verified orchestrator bearer only; worker
tier never reaches the tool; tainted/worker content triggers nothing without the human gate; bound to the
opaque id; single-use nonce; node-pty MAIN-only; sandbox/isolation unchanged; `gitDiff` not unblocked) —
it just drops the await-idle/result. `write_result` is the first worker write and is the narrowest possible:
bound to `ctx.boardId`, no PTY, no confirm, only the result store.

**Gate (green):** app typecheck · lint (0 err; the 1 pre-existing `no-console` in `PlanningBoard.tsx` is
untouched) · format · **738 unit** · build. `CANVAS_SMOKE=mcp` → `MCP_ASSIGN_OK` + `MCP_WRITE_RESULT_OK`
+ `MCP_DONE` exit 0. `CANVAS_SMOKE=e2e` → `dispatch-assign` + `dispatch-write-result` ok:true (the
`browser`/`browser-gesture`/`focus-detach` trio is the known contended-host capturePage env flake — memory
`e2e-browser-trio-flake`; e2e is FROZEN in CI, `check` is the gate). pkg `pnpm test` → **71 contract** + lint
+ build(+DTS).

> ⚠️ **pkg `tsc --noEmit` is STILL RED on the base** (now ~50 pre-existing errors in test files: contract-test
> orchestrators that `implements Orchestrator` directly were never updated for
> `closeBoard`/`configureBoard`/`handoffPrompt`, and `writeResult` widens that). NOT introduced by T4.4; the
> pkg gate is **`pnpm test` + `pnpm build` + `pnpm lint`**, NOT typecheck. Clean it in a dedicated pass if
> desired (make those test classes `extends MockOrchestrator`).

## Read first (for T4.5)
1. `Z:\Canvas ADE\CLAUDE.md` — Process model & security · `docs/roadmap-mcp.md` § M4.
2. The seam to copy: `src/main/mcpOrchestrator.ts` `dispatchPrompt` (assign) — the closest sibling. T4.5
   `interrupt` is the same gating with `'\x03'` instead of `text+'\r'` and no prompt body.
3. `src/main/pty.ts` — `drainPty` already writes `'\x03'`; `writeToPty` is the sessions-keyed write seam.
4. Memories: `e2e-browser-trio-flake` · `bash-tool-commit-backticks` (commit via heredoc `-F -`).

## T4.5 — `interrupt(boardId)` (orchestrator-tier)
- Send `'\x03'` (Ctrl-C) to the target terminal's PTY to interrupt a runaway/long command. Same 🔒 gating
  as assign_prompt (opaque id → terminal-only → nonce → **human confirm** → audit → write), content-less
  (audit `prompt: ''`). `Orchestrator.interrupt(boardId): Promise<void>` on the pkg interface + Mock no-op;
  orchestrator-tier tool `interrupt` (input `{boardId}` `.min(1)`); reuse `writeToPty(id, '\x03')` (no CR).
  Stack pkg `feat/interrupt` off `feat/assign-result` (bump **0.7.0** HELD). app sub-branch
  `feat/mcp-t4-5-interrupt` off the umbrella. smoke `MCP_INTERRUPT_OK` + e2e `dispatch-interrupt`.
- Then **T4.6** agent-to-agent over the M2 orchestration connector cable (A→B resolves its target from the
  edge; 🔒 terminal→terminal only, one-directional, never Browser→PTY) — the M4 GATE.

## Cadence (mandatory, same as before)
- TDD every pure/decidable unit FIRST (watch it fail). Gate = `pnpm typecheck && pnpm lint &&
  pnpm format:check && pnpm test && pnpm build`, then BOTH smokes (`CANVAS_SMOKE=mcp` → `MCP_…_OK …
  MCP_DONE`; `CANVAS_SMOKE=e2e` → `E2E_DONE`; rerun the known browser-trio flake for clean). pkg:
  `cd Z:\canvas-ade-mcp; pnpm test`.
- One app sub-branch off the umbrella + a matching stacked pkg `feat/*` (bump 0.7.0 HELD) → squash-merge
  the app branch back when green (`git merge --squash` then `git branch -D`) → push the umbrella → write
  `docs/superpowers/handoffs/2026-06-03-mcp-t4-5-interrupt.md`.
- Update YOUR row on `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` BEFORE editing. ⚠️ CROSS-ZONE
  `src/main/index.ts` with `feat/context` (additive, no shared lines). Do NOT publish the pkg or bump the
  app floor without the user's go-ahead. Do NOT merge the umbrella to app `main` (user's call).

## 🚦 M4 gate (still open until T4.6)
A confirmed, audited, nonce-protected prompt executes in the target terminal (handoff + assign ✅); a worker
tier is denied every dispatch tool but CAN `write_result` ✅; tainted worker content triggers nothing
without the human gate ✅ — both `CANVAS_SMOKE=mcp` and `CANVAS_SMOKE=e2e` green. Remaining: T4.5 interrupt
+ T4.6 agent-to-agent.
