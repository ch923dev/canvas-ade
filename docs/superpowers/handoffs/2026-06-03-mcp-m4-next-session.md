# MCP M4 — Dispatch — next-session kickoff prompt

You are continuing the Canvas ADE × MCP integration roadmap. **M0 + M1 (Observation) + M2 (Spatial
connectors) + M3 (Lifecycle tools) are COMPLETE** on `feat/mcp-integration`. This session: build
**Milestone M4 — Dispatch** by completing **T4.1 → T4.6 SEQUENTIALLY** (one card fully green +
squash-merged + handed off before the next). Do NOT parallelize.

⚠️ **M4 IS THE MOST SECURITY-SENSITIVE MILESTONE SO FAR.** It gives the orchestrator a *voice into
another agent's shell* — it writes to a target board's PTY. The whole milestone is gated on: **no
dispatch from worker-originated (tainted) content, every dispatch human-confirmed + audited, and
terminal→terminal ONLY (Browser content must NEVER reach the PTY write channel).** Treat every line as
a potential injection vector. Like M3 it spans BOTH repos (pkg tool + app adapter), AND it adds two NEW
app subsystems: an **append-only audit log + viewer** and a **human-confirm modal**.

## REPOS / RUNTIME

- **WORK HERE (app):** `Z:\canvas-ade-mcp-int` — branch `feat/mcp-integration`. Cut task sub-branches
  off it; squash-merge back. (Worktree `node_modules` is its OWN, de-junctioned — normal pnpm; do NOT
  re-junction.)
- **WORK HERE (pkg):** `Z:\canvas-ade-mcp` — `@ch923dev/canvas-ade-mcp`. M4 adds dispatch tools here.
  Dev loop = the `pnpm mcp:link` symlink (app `node_modules/@ch923dev/canvas-ade-mcp` → the sibling), so
  the app sees pkg edits live WITHOUT publishing. Publish stays user-gated (`tag v*` via CI). **Held
  chain is currently 0.4.0/0.4.1/0.4.2 (UNPUBLISHED).** M4 bumps to **0.5.x**, also HELD until the user
  green-lights a publish. NEVER commit a `link:` lockfile entry; `package.json`/lockfile stay on the
  published `^0.2.4` floor (CI-safe) — the symlink overrides it in dev. The pkg M4 tools go on stacked
  `feat/*` branches off the current held tip (`feat/configure-board`, 0.4.2).
- **APP main `Z:\Canvas ADE`** — integration only; NEVER work there (shared-dir collision hit this
  project twice). Do NOT merge `feat/mcp-integration` to app main (user's call).

## READ FIRST (in order)

1. `Z:\Canvas ADE\CLAUDE.md` — durable contract. Especially **Process model & security**
   (contextIsolation/sandbox/no-nodeIntegration; node-pty ONLY in MAIN; **treat launchCommand as
   trusted-user-only; Browser-board content must NEVER reach the PTY write channel**) and **Terminal
   bridge** (spawn the shell, write launchCommand as the first PTY line; kill the tree on close).
2. `docs/roadmap-mcp.md` § **M4 — Dispatch** — the 6 task cards (T4.1–T4.6) + the M4 gate.
3. The **M3 handoffs** for the exact cadence + the seams M4 builds on:
   `docs/superpowers/handoffs/2026-06-03-mcp-t3-{1,2,3,4}-*.md`.
4. The seams M4 extends:
   - `src/main/mcpOrchestrator.ts` — `dispatchPrompt(boardId, text)` currently **THROWS** "not available
     until Phase 4". M4 (T4.3/T4.4) makes it real. `gitDiff` stays gated (Phase 6). The cap tracker +
     `LifecycleOrchestrator` live here.
   - `src/main/mcpCommand.ts` + `src/renderer/src/store/useMcpCommands.ts` — the MAIN→renderer command
     channel + applier. M4's **human-confirm modal** (T4.2) most likely rides this (a renderer modal
     driven by an `mcp:command`, with MAIN as the authority) — testable via the harness. Alternative:
     `dialog.showMessageBox` (truly native, but e2e-opaque). **Recommend the renderer-modal-via-command
     route for testability; MAIN still owns the decision.**
   - `src/main/pty.ts` — owns the PTY sessions map + `drainPty`. M4 needs a **production PTY-write path**
     (`writeToPty(id, text)` — write to `sessions.get(id).proc`), terminal-only, plus an interrupt
     (Ctrl-C `'\x03'`) for T4.5. `debugWriteTerminal` is the e2e seam; the dispatch write is the real one.
   - `src/main/mcp.ts` + `src/main/index.ts` — how the server is mounted + `getWin`/`sendCommand`/
     `drainPty` are threaded into the registry; M4 threads the new PTY-write + confirm + audit seams.
   - `src/main/mcpSmoke.ts` — extend with dispatch tier assertions (orchestrator can dispatch; worker
     DENIED `handoff_prompt`/`assign_prompt`/`interrupt`; **`write_result` is the FIRST worker-tier write
     tool** — verify a worker CAN call it and an orchestrator's tier split is correct).
5. The package side: `Z:\canvas-ade-mcp\docs\roadmap.md` § Phase 4, `src/orchestrator/Orchestrator.ts`
   (the interface — `dispatchPrompt` already declared; M4 likely adds a blocking `handoffPrompt`
   returning a result + an `interrupt`), `src/server/factory.ts` (per-tier registration — **M4 adds a
   WORKER-tier tool `write_result`, so the worker branch gets its first registered write tool**),
   `src/auth/scopes.ts` (`SCOPE_DISPATCH` already in the orchestrator tier — wire per-tool gating).
6. Memories (recalled automatically): `mcp-publish-gating` · `canvas-ade-mcp` · `mcp-spec-state-2026-06`
   (⚠️ **sampling is deprecated + Claude Code never implemented MCP sampling** — M4 dispatch is PTY-write,
   not sampling, so unaffected, but keep it in mind for M8/M9) · `undo-lastrecorded-phantom` ·
   `e2e-sendinputevent-vs-dispatchevent` · `e2e-browser-trio-flake` · `paste-fires-at-document`.

## STATE OF PLAY (end of M3, 2026-06-03)

- App umbrella `feat/mcp-integration` (PUSHED to origin, NOT on app main): M0+M1+M2+**M3** done.
  M3 commits: **T3.1 `5331320`** (spawn_board) · **T3.2 `6896cfc`** (close_board, graceful `drainPty`) ·
  **T3.3 `487bdab`** (configure_board) · **T3.4 `a13ccaf`** (cap + idle-reap, the gate).
- **pkg held chain (PUSHED, UNPUBLISHED): 0.4.0/0.4.1/0.4.2** — stacked
  `feat/spawn-board`→`feat/close-board`→`feat/configure-board` off the 0.3.2 M1 tip.
- App gate green: **696 unit**, typecheck/lint/format/build. Live MCP smoke
  `MCP_SPAWN/CONFIGURE/CLOSE/CAP_OK` (+ `CANVAS_MCP_IDLE_TTL_MS=800` → `MCP_REAP_OK`) exit 0. Board e2e
  `lifecycle-spawn-close` green; the `browser`/`browser-gesture`/`focus-detach` trio is the documented
  `e2e-browser-trio-flake` (capturePage env flake, not a gate — board e2e is FROZEN in CI per CLAUDE.md
  Status; the `check` job is the gate).
- The write path is established: a tool (orchestrator-tier only) → an `Orchestrator` method → a
  frame-guarded `mcp:command` → `canvasStore`. **M4's new twist: the target is another board's PTY, not
  the canvas store** — so the dispatch write goes MAIN-side (`pty.ts`), gated by confirm + nonce + audit
  + taint checks, NOT through the renderer command channel (except the confirm-modal UI).

## THE 6 CARDS, IN ORDER (full cards in `docs/roadmap-mcp.md` § M4)

- **T4.1 — Audit log infrastructure + viewer shell** (`feat/mcp-t4-1-audit-log`)
  app: append-only **audit log** in MAIN (resolved target + full prompt + outputs + nonce + timestamp)
  persisted under `app.getPath('userData')` (NEVER the project folder); a minimal read-only **viewer**
  UI. 🧪 e2e: a dispatched action writes an entry the probe reads back.
- **T4.2 — 🔒 Human-confirm modal infrastructure** (`feat/mcp-t4-2-confirm-modal`)
  app: a reusable confirm modal — MAIN owns the decision; returns approve/deny to the calling tool. Used
  by M4/M6/M7. 🧪 e2e: a tool requiring confirm BLOCKS until the (harness-driven) modal resolves.
- **T4.3 — 🔒 `handoff_prompt` (blocking)** (`feat/mcp-t4-3-handoff-prompt`)
  pkg tool (send → await idle → return result). app adapter: **provenance-tag** the prompt (unspoofable
  "from orchestrator"), single-use **nonce** + monotonic sequence, **human-confirm** (T4.2), **write to
  the target board's PTY** (MAIN owns the PTY — **terminal→terminal ONLY, never Browser→PTY**), await
  idle (interim poll until M5), **audit** (T4.1). Bind to the opaque server id. 🧪 e2e: text lands in the
  worker PTY + runs + result returns; **replayed nonce rejected; label-targeting rejected; audit written.**
- **T4.4 — `assign_prompt` (fire-and-forget) + `write_result`** (`feat/mcp-t4-4-assign-and-result`)
  pkg tools; app fire-and-forget dispatch; **`write_result` is a WORKER-tier tool** → feeds the `result`
  resource (T1.5, `recordBoardResult` already exists). 🧪 e2e: assign → worker runs async →
  `write_result` surfaces in `canvas://board/{id}/result`.
- **T4.5 — `interrupt(id)`** (`feat/mcp-t4-5-interrupt`)
  pkg tool; app sends Ctrl-C (`'\x03'`) to the target PTY. 🧪 e2e: a long task is interrupted.
- **T4.6 — Agent-to-agent over the connector cable** (`feat/mcp-t4-6-cable-dispatch`)
  app: a dispatch from board A→B is expressed by an **`orchestration` connector** (M2): the cable is the
  routing + intent UI; dispatch resolves its target from the edge. 🔒 **terminal→terminal only,
  one-directional, never Browser→PTY.** 🧪 e2e: draw a cable A→B, dispatch along it → lands in B.

**🚦 M4 gate:** a confirmed, audited prompt executes in the target board; **tainted worker output can
trigger NOTHING without the human gate.**

## SECURITY (never weaken — M4 is the dangerous one)

- **Taint / provenance:** a dispatch's authority comes ONLY from the verified orchestrator bearer
  (`ctxFromAuth` re-derives tier server-side). A worker tier must NEVER reach `handoff_prompt`/
  `assign_prompt`/`interrupt` (assert in the smoke). **Worker-originated content (board output, results)
  must never auto-trigger a dispatch** — there is always a human confirm between observation and action.
- **terminal→terminal ONLY:** validate the target is a `terminal` board before any PTY write. **Browser
  board content must NEVER reach the PTY write channel** (CLAUDE.md). Reject a Browser/Planning target.
- **Nonce + monotonic sequence:** every dispatch carries a single-use nonce + an increasing sequence;
  a replayed nonce is rejected. Bind to the **opaque server board id**, never a label (label-targeting
  rejected — labels are user-mutable + spoofable).
- **Human-confirm is mandatory** for `handoff_prompt`/`assign_prompt` (T4.2 modal). MAIN owns the
  decision; a tainted prompt can't bypass it.
- **Audit everything** (T4.1): resolved target, full prompt, nonce, sequence, outputs, timestamp — under
  `userData`, append-only.
- node-pty stays in MAIN; the renderer never touches Node/native. Do NOT weaken
  contextIsolation/sandbox/nodeIntegration. Commands/confirm stay frame-guarded
  (`isForeignSender`/main-frame pattern already in `mcpCommand.ts`/`boardRegistry.ts`).
- Do NOT unblock `gitDiff` (M6) — it stays phase-gated this session.

## TESTING (the whole point — this is a WRITE-TO-ANOTHER-SHELL path)

- **TDD first** for every pure/decidable unit: nonce issue/verify, sequence monotonicity, target
  resolution (id vs label; terminal vs non-terminal reject), taint/provenance checks, the
  command-envelope mapping, audit-entry shaping. Write the failing test, watch it fail, then implement.
- **Two e2e surfaces, BOTH green per card:**
  a. **App board e2e `CANVAS_SMOKE=e2e`** (renderer side): extend `src/main/e2e/probes/lifecycle.ts` (or
     a new `dispatch.ts`) + the playlist. Probes MUST restore baseline (seed count returns to 4). Drive
     the real round-trip; poll, don't fixed-sleep (memory `e2e-rf-measurement-race`). For "text lands in
     the worker PTY", read it back off the framebuffer the way the `terminal` probe does
     (`readTerminal(id)` + a sentinel). For confirm-modal gating, drive the harness modal.
  b. **Live MCP smoke `CANVAS_SMOKE=mcp`** (`mcpSmoke.ts`): orchestrator can dispatch; **worker DENIED**
     the dispatch tools; **worker CAN `write_result`** (its tier's first write tool) + it surfaces in the
     result resource; replayed-nonce + non-terminal-target rejections asserted. **Self-skip** cleanly on
     a pkg predating the M4 tools (the `MCP_*_SKIP` pattern) so the gate stays green pre-publish.
- **Gate before each handoff** (the REAL gate = the `check` job): `pnpm typecheck && pnpm lint &&
  pnpm format:check && pnpm test && pnpm build`. Then both smokes locally: `pnpm build;
  CANVAS_SMOKE=mcp pnpm start` (expect `MCP_*_OK … MCP_DONE` exit 0; the dispatch/result/interrupt
  markers) AND `CANVAS_SMOKE=e2e pnpm start` (E2E_DONE; the browser-trio is a known env flake — rerun
  for clean, memory `e2e-browser-trio-flake`). pkg: `cd Z:\canvas-ade-mcp; pnpm test; pnpm test:live`.

## CADENCE — MANDATORY per card

- One sub-branch off `feat/mcp-integration` (app) + a matching stacked pkg `feat/*` (off the held tip) →
  squash-merge the app branch back when green → THEN the next card.
- Pkg tool work is HELD/unpublished (the 0.5.x chain); the app consumes it live via `pnpm mcp:link`. Do
  NOT publish or bump the app floor unless the user green-lights it. Bump pkg version per card (0.5.0,
  0.5.1, …).
- Write a handoff `docs/superpowers/handoffs/2026-06-03-mcp-t4-N-*.md` after each card.
- Update YOUR row on `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` BEFORE editing; declare zones.
  ⚠️ CROSS-ZONE: `src/main/index.ts` + `src/preload/index.ts` are also touched by `feat/context`
  (additive). The audit-viewer + confirm-modal touch the renderer (`App.tsx`/new components) — declare
  them.

## DO NOT

- Do NOT publish the pkg or bump the app floor without the user's go-ahead (publish = `tag v*`,
  user-gated).
- Do NOT re-junction the worktree `node_modules`. Do NOT commit a `link:` lockfile entry.
- Do NOT merge `feat/mcp-integration` to app main. Do NOT work in `Z:\Canvas ADE` main dir.
- Do NOT let a worker tier reach a dispatch/interrupt tool. Do NOT let Browser content reach the PTY.
- Do NOT dispatch without a human confirm + a fresh nonce + an audit entry. Do NOT target by label.
- Do NOT unblock `gitDiff` (M6).

## START BY

`cd Z:\canvas-ade-mcp-int`; confirm branch `feat/mcp-integration` + the `pnpm mcp:link` symlink is active
(`node_modules/@ch923dev/canvas-ade-mcp` → the sibling, resolves 0.4.2). Read `docs/roadmap-mcp.md` § M4
+ `mcpOrchestrator.ts` (`dispatchPrompt` throws Phase 4) + `pty.ts` (the PTY sessions map — where the
write path lands) + `mcpCommand.ts`/`useMcpCommands.ts` (the confirm-modal channel). Declare T4.1 zones
on `ACTIVE-WORK.md`. Then build **T4.1 test-first**: the MAIN audit log (append-only JSONL under
`userData`) + a read-only viewer shell + an e2e probe that reads back a written entry. Finish +
squash-merge + handoff T4.1 before starting T4.2.

**M4 is done when** an orchestrator agent can hand a confirmed, audited, nonce-protected prompt to a
target *terminal* board (and only a terminal), it executes in that board's PTY, the worker reports back
via `write_result`, `interrupt` can stop a runaway, dispatch can ride an `orchestration` cable, a worker
tier is denied every dispatch tool, tainted worker content can trigger nothing without the human gate —
with both `CANVAS_SMOKE=mcp` and `CANVAS_SMOKE=e2e` green.
