# Handoff — MCP M4 T4.2: Human-confirm modal infrastructure 🔒

- **Date:** 2026-06-03
- **Milestone:** M4 (Dispatch 🔒) — **card 2 of 6**. The mandatory human gate every dangerous MCP
  action (M4 dispatch, M6 merge, M7 permission) blocks on. **App-only** (no pkg surface).
- **App branch:** `feat/mcp-t4-2-confirm-modal` → squash-merged into `feat/mcp-integration`.

## What shipped

A reusable confirm gate: a tool calls MAIN `requestConfirm(...)`, which posts to the renderer, shows a
blocking modal, and resolves the human's decision — MAIN owns the gate (it blocks the caller on the
reply). **Dedicated `mcp:confirm` channel** (NOT the `mcp:command` union): confirm needs an async modal
reply, NO 2 s timeout (a human takes time), and an explicit `{approved}` decision rather than ok/error.

```
dangerous tool (T4.3+) ─▶ requestConfirm(ipcMain, getWin, {title, body})   [MAIN, blocks]
                               │  mcp:confirm {request, replyChannel}
                               ▼
                          ConfirmModal  ──reply {approved}──▶  resolves the tool
```

### Files
- **`src/main/mcpConfirm.ts`** (NEW) — `requestConfirm(bus, getWin, request, {timeoutMs?})` →
  `Promise<{approved}>`. 🔒 **Fail-closed in every degenerate case**: gone/destroyed window, send throw,
  malformed reply, foreign-frame reply, or the optional safety-timeout ALL resolve `{approved:false}`.
  The ONLY approve path is a genuine main-frame reply with `approved === true`. Frame-guarded
  (`isForeignSender`), injected bus (unit-testable), never throws. Mirrors `sendMcpCommand`'s shape.
- **`src/preload/index.ts`** (+) — `api.mcp.onConfirm(handler)` (subscribe; handler gets
  `(request, reply)`, reply sends the decision on MAIN's reply channel) + a mirrored `ConfirmRequest`.
- **`src/renderer/src/canvas/ConfirmModal.tsx`** (NEW) + `App.tsx` mount (always-mounted; renders null
  when idle → zero DOM/listener footprint). FIFO **queue** so two dispatches can't race one modal. Esc /
  backdrop click = deny. `data-testid` hooks (`confirm-modal`/`confirm-approve`/`confirm-deny`) for e2e.
- **`src/main/e2e/probes/dispatch.ts`** (+`dispatchConfirm`) + playlist — proves the gate **BLOCKS**
  (races the unanswered promise vs a 250 ms delay → must be pending), then approve→`{approved:true}` and
  a second request deny→`{approved:false}`, driving the real modal buttons.

## Gate (all green)
- typecheck · lint (0 err; pre-existing `PlanningBoard` `no-console` warning only) · format:check ·
  **714 unit** (+6 `mcpConfirm`: approve/deny/malformed-deny/foreign-deny/no-window-deny/send-throw-deny) ·
  build.
- `CANVAS_SMOKE=e2e` → `E2E_DISPATCH-CONFIRM ok:true` ("gate blocked until answered; approve→true,
  deny→false") + `dispatch-audit` ok:true + seed baseline 4.
- `CANVAS_SMOKE=mcp` → `MCP_DONE` (no MCP-surface regression; T4.2 adds none).

## Notes for the next card (T4.3 — handoff_prompt, blocking 🔒)
- **This is the gate to call before the PTY write.** Flow: resolve target (by opaque id, NOT label) →
  validate **terminal-only** (reject browser/planning) → mint single-use nonce + monotonic sequence →
  `requestConfirm(ipcMain, () => mainWindow, { title, body })` showing the RESOLVED target + the exact
  prompt → on `{approved:false}` audit a `denied`/`rejected` entry and STOP → on approve, write to the
  target PTY (MAIN `pty.ts`) → await idle (interim poll) → audit `completed` with outputs.
- **Wire `requestConfirm` into the registry** like `sendCommand`/`drainPty`: inject
  `confirm: (req) => requestConfirm(ipcMain, () => mainWindow, req)` into `BoardRegistry` in `index.ts`,
  and `audit: getAuditLog()` (or pass append). Keep MAIN the authority — the package tool just calls the
  adapter method; the adapter does confirm+nonce+taint+PTY-write+audit.
- **Audit statuses** the viewer already colours: `dispatched` / `completed` / `denied` / `rejected` /
  `interrupted`. Record the resolved target + full prompt + nonce + sequence on BOTH the gate decision
  and the result.
- ConfirmModal queues, so concurrent dispatches serialize on the human cleanly.
- The confirm has no auto-timeout by default (a human may take time); degenerate cases still deny. If
  T4.3 wants a belt-and-braces ceiling, pass `{timeoutMs}` (resolves deny).
