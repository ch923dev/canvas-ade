# Handoff — MCP M4 T4.1: Dispatch audit log infrastructure + viewer shell

- **Date:** 2026-06-03
- **Milestone:** M4 (Dispatch 🔒) — **card 1 of 6**, the foundational forensic record. **App-only**
  (no pkg surface, no MCP tool yet — the dispatch tools T4.3+ write _through_ this).
- **App branch:** `feat/mcp-t4-1-audit-log` → squash-merged into `feat/mcp-integration`.
- **Pkg:** untouched (held chain stays 0.4.0/0.4.1/0.4.2, unpublished; dev via `pnpm mcp:link`).

## What shipped

An append-only audit trail in MAIN + a read-only renderer viewer. The seam every M4 dispatch tool
records through is live **before** any board can dispatch:

```
dispatch tool (T4.3+) ─┐
e2e probe ─────────────┴─▶ getAuditLog().append(entry)   [MAIN, append-only JSONL under userData]
                                     │
   renderer viewer  ◀── audit:read ──┘  (frame-guarded invoke; READ-ONLY, no write/clear IPC)
```

### Files (all net-new except 3 additive touch-points)
- **`src/main/auditLog.ts`** (NEW) — `createAuditLog({dir, now?})` → `{ append, read }`. Append-only
  via `fs.appendFile` (NOT write-file-atomic — that rewrites the whole file, defeating an append log).
  Pure `shapeAuditEntry(input, seq, ts)`: stamps seq+ts, defaults `status:'dispatched'`, **bounds every
  field** (`MAX_SHORT=256` id/type/nonce/status, `MAX_LONG=100_000` prompt/outputs/detail) so a forged
  oversized payload can't grow the log unboundedly, omits absent optionals. **Monotonic seq** seeded
  once from the file's max existing seq → survives restart / a fresh instance over the same dir. `read`
  is newest-first, capped (default 200), tolerant of blank/corrupt lines.
- **`src/main/auditIpc.ts`** (NEW) — `registerAuditHandler(ipcMain, getWin, log)`: frame-guarded
  (`isForeignSender`) `audit:read` invoke; `getAuditLog()` process-wide accessor (the dispatch-tool /
  e2e write seam). **No `audit:write` IPC by design** — a compromised renderer can't forge or erase an
  entry.
- **`src/main/index.ts`** (+4) — `registerAuditHandler(ipcMain, () => mainWindow, createAuditLog({ dir:
  app.getPath('userData') }))`, wired right after `registerProjectHandlers` (before `createWindow`, so
  the seam is live for the e2e smoke). 🔒 userData, **never** the project folder.
- **`src/preload/index.ts`** (+) — `api.mcp.readAudit(opts?)` (invoke-only) + a mirrored `AuditEntry`
  type (`CanvasApi = typeof api` types it through automatically).
- **`src/renderer/src/canvas/AuditLogViewer.tsx`** (NEW) + `App.tsx` mount — minimal read-only panel,
  toggled ⌘/Ctrl+Shift+A or a low-key bottom-left launcher; lists seq/type/status/target/prompt; pulls
  via `readAudit` on each open (no setState-in-effect — open/close go through `openRef`-gated handlers).
- **`src/main/e2e/probes/dispatch.ts`** (NEW) + playlist entry `dispatch-audit` (before `seed`) —
  MAIN appends a sentinel entry via `getAuditLog()`, then asserts the RENDERER reads it back over
  `audit:read` AND the viewer renders the row (`[data-audit-seq]`). No baseline mutation (separate file).

## Gate (all green)
- typecheck · lint (0 err; the 1 `PlanningBoard` `no-console` warning is pre-existing, out of zone) ·
  format:check · **708 unit** (+12: 9 `auditLog` + 3 `auditIpc`) · build.
- `CANVAS_SMOKE=e2e` → `E2E_DISPATCH-AUDIT ok:true` ("persisted → read back via IPC + rendered in
  viewer"); full clean run on rerun (the preview-edge / connector-render / fullview-close set flaked
  once → all green on rerun, memory `e2e-browser-trio-flake`; NOT a regression — disjoint from this card).
- `CANVAS_SMOKE=mcp` → `MCP_DONE`, all `MCP_*_OK` (no MCP-surface regression; T4.1 adds none).

## Notes for the next card (T4.2 — human-confirm modal)
- **The audit seam is `getAuditLog()`** in `auditIpc.ts`. T4.3 dispatch appends `{type:'handoff_prompt',
  targetId, prompt, nonce, status}` here; record an entry on confirm/deny/reject too (status buckets the
  viewer already colours: dispatched/completed/denied/rejected/interrupted).
- **Recommended T4.2 route** (per the kickoff): a renderer modal driven by an `mcp:command` (extend the
  `McpCommand` union — same channel `useMcpCommands` applies), MAIN owns the decision + blocks the tool
  on the ack. Testable via the harness (drive the modal). `dialog.showMessageBox` is the e2e-opaque
  alternative — avoid.
- **Audit field bounds** are generous but real — if T4.3 needs the full untruncated prompt for forensics,
  revisit `MAX_LONG` (currently 100k chars).
- **Follow-up (non-blocking):** the log is unbounded on disk (append-only, no rotation) and the e2e
  probe writes real entries into the dev userData log each run (harmless, read caps to 200). Rotation /
  a `clear` affordance can land later without touching the data path.
