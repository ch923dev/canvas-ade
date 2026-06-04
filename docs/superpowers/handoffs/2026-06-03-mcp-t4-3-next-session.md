# Next-session kickoff — MCP M4 T4.3: `handoff_prompt` (blocking) 🔒

> **You are continuing M4 (Dispatch) on `feat/mcp-integration`.** M0/M1/M2/M3 done; **M4 T4.1
> (audit-log) + T4.2 (confirm-modal) are DONE** (squash-merged, pushed). This session: build **T4.3 —
> `handoff_prompt`**, the keystone. It is the FIRST card that writes into another agent's PTY. Then
> continue T4.4 → T4.6 sequentially (one card fully green + squash-merged + handed off before the next).
> **🔒 M4 is the dangerous milestone — treat every line as an injection vector. TDD-first, no shortcuts.**

## State of play (verified end of T4.2, 2026-06-03)

- **App umbrella `feat/mcp-integration`** (pushed): T4.1 `21baf48` (audit), T4.2 `57533b0` (confirm).
  Gate green: **714 unit**, typecheck/lint(0-err)/format/build; `CANVAS_SMOKE=e2e` `dispatch-audit` +
  `dispatch-confirm` ok:true; `CANVAS_SMOKE=mcp` `MCP_DONE`.
- **pkg sibling `Z:\canvas-ade-mcp`** is on **`feat/configure-board` (0.4.2)** = the held M4 base.
  Dev loop = `pnpm mcp:link` symlink (app sees pkg edits live after `pnpm mcp:build`; NO publish). The
  app floor stays published `^0.2.4` (CI-safe); the 0.3.x/0.4.x chain is HELD/unpublished. **T4.3 stacks
  a pkg branch `feat/handoff-prompt` off `feat/configure-board`, bumps 0.5.0, HELD.** (2 pre-existing
  dirty research docs in the pkg tree are NOT yours — leave them.)
- **The safety infra T4.3 consumes is already built (T4.1/T4.2):**
  - `src/main/auditLog.ts` — `createAuditLog({dir})` → `{append(AuditInput), read}`. AuditInput =
    `{type, targetId, prompt, nonce, status?, outputs?, detail?}`. Statuses the viewer colours:
    `dispatched`/`completed`/`denied`/`rejected`/`interrupted`.
  - `src/main/auditIpc.ts` — **`getAuditLog()`** returns the wired singleton (append through this).
  - `src/main/mcpConfirm.ts` — **`requestConfirm(ipcMain, getWin, {title, body, confirmLabel?, denyLabel?})`**
    → `Promise<{approved:boolean}>`, 🔒 fail-closed everywhere; blocks until the human answers via
    `ConfirmModal.tsx`.

## Read first
1. `Z:\Canvas ADE\CLAUDE.md` — Process model & security (node-pty MAIN-only; Browser content NEVER to
   the PTY write channel; spawn-shell-then-write-launchCommand; kill the tree).
2. `docs/roadmap-mcp.md` § M4 (the 6 cards + gate) and the T4.2 handoff
   `docs/superpowers/handoffs/2026-06-03-mcp-t4-2-confirm-modal.md` ("Notes for the next card").
3. Seams: `src/main/mcpOrchestrator.ts` (`BoardRegistry` + `buildOrchestrator`; `dispatchPrompt` still
   throws Phase 4) · `src/main/pty.ts` (`sessions` map; `debugWriteTerminal` line ~769 is the write
   primitive — only terminals have sessions, so sessions-keyed writes are inherently terminal-only;
   `drainPty` already writes `'\x03'` for Ctrl-C — reuse for T4.5) · `src/main/index.ts` ~174 (registry
   wiring) · `src/main/mcpSmoke.ts` (tier assertions) · `src/main/e2e/probes/dispatch.ts` (T4.1/T4.2
   probes; add T4.3 here) + playlist `src/main/e2e/index.ts`.
4. pkg: `src/orchestrator/Orchestrator.ts` (interface; `dispatchPrompt` already declared) ·
   `src/orchestrator/mock.ts` · `src/server/factory.ts` (orchestrator-tier registration block) ·
   `src/server/tools/configureBoard.ts` (the tool template) · `src/constants.ts` (`TOOL_*`) ·
   `src/auth/scopes.ts` (`SCOPE_DISPATCH` already in the orchestrator tier).
5. Memories: `mcp-publish-gating` (M4 progress + held-chain + de-junction rules) · `canvas-ade-mcp` ·
   `mcp-spec-state-2026-06` · `e2e-browser-trio-flake` (the preview/connector/fullview probe set flakes
   on a contended host → rerun for clean; NOT a gate — e2e is FROZEN in CI, `check` is the gate) ·
   `e2e-sendinputevent-vs-dispatchevent` · `bash-tool-commit-backticks` (commit via heredoc `-F -`).

## What T4.3 builds — `handoff_prompt` (blocking: send → await idle → return result)

### pkg (`feat/handoff-prompt` off `feat/configure-board`, bump 0.5.0 HELD)
- `Orchestrator.ts` — add **`handoffPrompt(boardId: BoardId, text: string): Promise<BoardResult>`**
  (blocking, returns the structured last result). Add to `mock.ts` (returns `{present:false}`).
- `constants.ts` — `TOOL_HANDOFF_PROMPT = 'handoff_prompt'`.
- `src/server/tools/handoffPrompt.ts` — `registerHandoffPrompt(server, orchestrator)`, **orchestrator
  tier ONLY** (register inside the `ctx.tier === 'orchestrator'` block in `factory.ts`, like
  spawn/close/configure — structural split, NOT a per-handler check). Input
  `{ boardId: z.string().min(1), prompt: z.string().min(1) }`; calls `orchestrator.handoffPrompt`,
  returns the result as text content.
- Contract test `test/contract/handoffPrompt.contract.test.ts` (tool calls orchestrator + returns
  result; an orchestrator-tier server lists it). Bump `package.json` 0.4.2 → **0.5.0**.

### app (`feat/mcp-t4-3-handoff-prompt` off `feat/mcp-integration`)
- **`src/main/dispatchGuard.ts`** (NEW, pure, TDD) — `createDispatchGuard()` → `{ issue(): {nonce, seq},
  consume(nonce): boolean }`. Monotonic seq; `consume` true once then false (replay rejected); unknown
  nonce → false. This is the single-use-nonce + monotonic-sequence security unit.
- **`src/main/pty.ts`** — add `writeToPty(id, text): boolean` (production; `sessions.get(id)` →
  `proc.write(text)`; absent/non-terminal → false). Same primitive as `debugWriteTerminal`, production-named.
- **`src/main/mcpOrchestrator.ts`** — implement `handoffPrompt`. Extend `BoardRegistry` with injected
  `writeToPty(id,text):boolean`, `confirm(req):Promise<{approved}>`, `audit(input):Promise<void>`. Logic
  (TDD with a fake registry):
  1. Resolve target by **opaque id** via `listBoards()`. Not found → audit `rejected` + throw
     (`label-targeting` is rejected for free — a title is not an id, so it won't match).
  2. **terminal-only**: `board.type !== 'terminal'` → audit `rejected` ("non-terminal target") + throw.
     NEVER write Browser/Planning to the PTY.
  3. `const {nonce, seq} = guard.issue()`.
  4. `requestConfirm` (injected) with the **resolved target + the exact prompt** in the body. Deny →
     audit `denied` + throw; **no PTY write**.
  5. `guard.consume(nonce)` (defensive; a replayed/forged nonce → throw, no write).
  6. `writeToPty(boardId, text + '\r')`. Failure → audit `failed` + throw.
  7. Await idle: interim poll `boardStatus`/`listSessions` until the terminal leaves `running` (bounded
     timeout — M5 replaces this with real attention). Then `readResult(boardId)` (T1.5 shell until T4.4
     write_result).
  8. audit `completed` (target + full prompt + nonce + seq + outputs). Return the `BoardResult`.
  - Keep `dispatchPrompt` throwing (T4.4 turns it into `assign_prompt`). Keep `gitDiff` gated (M6).
- **`src/main/index.ts`** — inject into the registry: `writeToPty`, `confirm: (req) =>
  requestConfirm(ipcMain, () => mainWindow, req)`, `audit: (e) => getAuditLog()?.append(e).then(()=>{}) ??
  Promise.resolve()`.
- **`src/main/mcpSmoke.ts`** — orchestrator can `handoff_prompt` to a terminal (text lands); **worker
  DENIED** `handoff_prompt` (tier split, server-side); replayed-nonce + non-terminal-target rejections
  asserted. Self-skip (`MCP_HANDOFF_SKIP`) on a pkg predating 0.5.0 so the gate stays green pre-publish.
- **e2e** `src/main/e2e/probes/dispatch.ts` (+ playlist): `handoff_prompt(worker, 'echo CANVAS_E2E…')`
  → text lands in the worker PTY (read back off the framebuffer with a sentinel, like the terminal
  probe) + runs + result returns; replayed nonce rejected; label-targeting rejected; audit entry written
  (read via `audit:read`). Restore baseline (seed → 4).

## Security (never weaken)
- Authority = the verified **orchestrator** bearer only (`ctxFromAuth` re-derives tier server-side). A
  **worker tier must NEVER reach** `handoff_prompt` (assert in the smoke). Worker-originated content
  (board output/results) must never auto-trigger a dispatch — the human confirm sits between observation
  and action, always.
- **terminal→terminal ONLY**; reject Browser/Planning targets before any write. Browser content NEVER
  reaches the PTY (CLAUDE.md).
- **Bind to the opaque server board id, never a label** (labels are user-mutable/spoofable).
- **Single-use nonce + monotonic sequence**; replayed nonce rejected.
- **Human-confirm mandatory** (T4.2). MAIN owns the decision; a tainted prompt can't bypass it.
- **Audit everything** (T4.1): resolved target + full prompt + nonce + seq + outputs + timestamp.
- node-pty stays MAIN-only; don't weaken contextIsolation/sandbox/nodeIntegration; commands/confirm stay
  frame-guarded. Do NOT unblock `gitDiff` (M6).

## Cadence (mandatory)
- TDD every pure/decidable unit FIRST (watch it fail): `dispatchGuard` issue/consume/replay, target
  resolution (id vs label, terminal vs non-terminal), confirm-deny → no-write, audit shaping.
- Gate before handoff (the REAL gate = `check`): `pnpm typecheck && pnpm lint && pnpm format:check &&
  pnpm test && pnpm build`. Then both smokes: `CANVAS_SMOKE=mcp pnpm start` (→ `MCP_…_OK` … `MCP_DONE`)
  AND `CANVAS_SMOKE=e2e pnpm start` (`E2E_DONE`; rerun the known flake set for clean). pkg:
  `cd Z:\canvas-ade-mcp; pnpm test`.
- One app sub-branch off the umbrella + a matching stacked pkg `feat/*` → squash-merge the app branch
  back when green (`git merge --squash` then `git branch -D`, since squash leaves it "unmerged") → push
  the umbrella → write a handoff `docs/superpowers/handoffs/2026-06-03-mcp-t4-3-handoff-prompt.md`.
- Update YOUR row on `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` BEFORE editing. ⚠️ CROSS-ZONE:
  `src/main/index.ts` + `src/preload/index.ts` + `App.tsx` also touched by `feat/context` (additive, no
  shared lines). Do NOT publish the pkg or bump the app floor without the user's go-ahead. Do NOT merge
  the umbrella to app `main`. Do NOT work in `Z:\Canvas ADE` main dir.

## Then T4.4–T4.6 (same cadence)
- **T4.4** `assign_prompt` (fire-and-forget — make the existing `dispatchPrompt` real) + `write_result`
  (the FIRST **worker-tier** write tool → feeds `canvas://board/{id}/result`, T1.5;
  `recordBoardResult`/`boardResults.ts` exists). Smoke must assert a worker CAN call `write_result` and
  the tier split is correct.
- **T4.5** `interrupt(id)` — pkg tool; app sends `'\x03'` to the target PTY (terminal-only; `drainPty`
  already uses it).
- **T4.6** Agent-to-agent over the M2 orchestration connector cable — dispatch A→B resolves its target
  from the edge; 🔒 terminal→terminal only, one-directional, never Browser→PTY.
- **🚦 M4 gate:** a confirmed, audited, nonce-protected prompt executes in the target terminal; a worker
  tier is denied every dispatch tool; tainted worker content can trigger nothing without the human gate.
