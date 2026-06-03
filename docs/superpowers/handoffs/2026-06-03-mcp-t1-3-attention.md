# Handoff — MCP roadmap T1.3: `canvas://attention`

- **Date:** 2026-06-03
- **Milestone/Task:** M1 (Observation) / **T1.3** (`docs/roadmap-mcp.md`)
- **Repos:**
  - `Z:\Canvas ADE` (app) — umbrella `feat/mcp-integration` (PR #32), commit `3ad960e`
    (squash-merged from `feat/mcp-t1-3-attention`).
  - `Z:\canvas-ade-mcp` (package) — branch `feat/board-attention`, commit `8bddc48`,
    `0.2.3 → 0.2.4`. **HELD / unpublished** (stacked on the T1.2 pkg branch `feat/board-states`).
- **Status:** ✅ done, both gates green. Pkg resource fully live-verified; app proves the reachable
  `failed` bucket end-to-end; attention-resource probe self-activates on publish.

## What landed

**`canvas://attention`** → the boards needing a human, with full detail (id/type/title/status), both
tiers. The "who needs me" view: an orchestrator (or the M5/SB-1 on-canvas needs-you queue) reads it
instead of scanning every board.

**Attention buckets:** `blocked`, `awaiting-review`, `failed` (`running`/`idle`/`static` don't need a
human). The resource surfaces all three; today only **`failed`** is emitted (a browser that fails to
load). `blocked` + `awaiting-review` get their **emit sites in M8** (permission-prompt detection + the
terminal `awaiting-input` wire) — the resource already lists them once they flow, no further resource
change.

### Scope note (why no app derivation change)
T1.1 already derives buckets in the renderer; T1.3's "attention set" is just a host-side **filter** of
those buckets — pure pkg. The realistic reachable attention case now is `failed` (browser load-failed,
which T1.1 already maps). Driving `blocked` requires M8's PTY permission-prompt detection (a terminal
state-store enrichment + `pty.ts` change), deliberately **not** pulled forward here — it belongs with
its detection logic in M8. So T1.3 = the resource + the e2e proving a real attention case, no risky
Canvas.tsx terminal-state refactor.

### Package (`Z:\canvas-ade-mcp`)
- **NEW** `src/resources/attention.ts` — `ATTENTION_BUCKETS` + pure `selectAttention(boards)` +
  `registerAttentionResource`. Wired into `registerBoardResources`.
- `test/contract/attention.contract.test.ts` (helper + resource read) + `test/live/attention.live.test.ts`.
- `package.json` 0.2.4.

### App (`Z:\Canvas ADE`)
- `src/main/mcpSmoke.ts` — `readAttention()` helper + the **`MCP_ATTENTION`** probe: seeds a browser at
  a refused URL (`http://127.0.0.1:59999/`), `fitView`s it (→ the native preview attaches + load fails),
  polls `canvas://boards` until the board reads **`failed`** (observable now, real end-to-end), then
  reads `canvas://attention` and asserts the failed board is listed.
  - **Self-activating:** `canvas://attention` only exists in pkg ≥0.2.4 → on 0.2.0 it 404s →
    **`MCP_ATTENTION_SKIP pkg<0.2.4-unpublished`** (exit 0). Resource-not-found matched specifically so
    a `Session not found` can't masquerade as a skip. The `failed`-bucket half is asserted **now**
    regardless of publish.

## Test evidence
- **Pkg gate:** typecheck ✓ · lint ✓ · `prettier --check` ✓ · `pnpm test` **30 contract** ✓ ·
  `pnpm test:live` **19 live** ✓ · `pnpm build` ✓.
- **App gate:** typecheck ✓ · lint ✓ (only the pre-existing PlanningBoard `no-console` warning) ·
  `prettier --check` ✓ · `pnpm test` **610 unit** ✓ · `pnpm build` ✓.
- **App live MCP smoke:** `CANVAS_SMOKE=mcp pnpm start` →
  `MCP_LIST_OK / MCP_TIER_OK / MCP_BOARDS_OK / MCP_STATUS_OK / MCP_STATES_SKIP / MCP_ATTENTION_SKIP /
  MCP_COMMAND_OK / MCP_DONE`, **exit 0** (the browser reached `failed` — else the probe would
  `MCP_FAIL` before the skip).

## Manual (per cadence)
- **Automated equivalent done:** the pkg **live** test reads `canvas://attention` over real HTTP.
- **By hand on publish (Inspector):** point a Browser board at a dead URL (or trigger a future blocked
  terminal) → read `canvas://attention`, confirm only that board is listed.

## ⚠️ Publish gate (memory `mcp-publish-gating`)
**Four pkg versions now queued for one publish: 0.2.1 (host-guard) · 0.2.2 (status) · 0.2.3
(board-states) · 0.2.4 (attention).** App `^0.2.0` caret covers all. On publish, `MCP_STATES` +
`MCP_ATTENTION` + the T1.1 templated-resource probe all light up — re-run the app live smoke.

## Follow-ups / next
- **T1.4 — 🔒 `canvas://board/{id}/output`**: capped/paginated PTY scrollback (25k cap). First card that
  needs a real `pty.ts` read accessor (size-capped, never the raw buffer) — app-heavy + security-tagged.
- **M8** owns the `blocked`/`awaiting-review` emit sites that populate `canvas://attention` for terminals.
- **Do not merge to `main`** — finish MCP phases on the umbrella first (user's standing decision).
