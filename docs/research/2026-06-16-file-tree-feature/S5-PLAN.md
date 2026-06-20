# File-Tree S5 — Agent-context wiring (MCP) — implementation plan

> Slice S5 of the file-tree epic. Branch `feat/file-tree-s5-mcp-context`, base `feat/file-tree`.
> Charter: `SLICES.md` › "S5 — Agent-context wiring (MCP)". **No UI/UX change → no design artifact
> required** (this is a MAIN-side data-exposure + static-table + tests slice).

## Goal

Make **file boards** (`type:'file'`, carries a project-relative `path`) and **Planning file-reference
elements** (`kind:'fileref'`, carries `path` + `label`) appear as **agent-readable context** through an
MCP resource the agent READS — without ever injecting file contents into the PTY write channel.

## The decisive constraint (why S5 is shaped the way it is)

Two facts, verified on this branch:

1. **The MCP resources/tools are owned by the published `@expanse-ade/mcp` package**, not this repo.
   `src/main/mcp.ts` only injects an *orchestrator* into `createMcpHttpServer`. The package registers
   the wire-reachable resources: `canvas://boards`, `canvas://board-states`, `canvas://attention`,
   `canvas://memory`, and per-board `…/output|result|status|summary`. There is **no** `canvas://files`
   and **no** `canvas://app-model` resource in the pinned version (`^0.12.0` → `0.13.0` installed).
   → Adding a *new* resource would require a package change + npm publish + pin bump. **Out of scope
   for a clean S5.**

2. **`canvas://boards` serializes `orchestrator.listBoards()` verbatim** (`JSON.stringify(await
   orchestrator.listBoards())` in the package). `listBoards()` is `listBoardSummaries()` in
   `mcpOrchestrator.ts`, which re-projects each board to `{id,type,title,status,agentKind?,
   monitorActivity?}` from the renderer-pushed **board mirror** (`boardRegistry.ts`).
   → We can surface file context over the **existing** wire resource with **no package change** by
   threading `path` (file boards) + `fileRefs` (planning boards) through that projection.

### Live-agent wire caveat (important for the eyeball)

On `feat/file-tree` (and `main`), a **real terminal agent has no live MCP connection**: there is no
`.mcp.json` provisioning and no MCP port/token injected into the PTY env (`.mcp.json` /
`enabledMcpjsonServers` appear only in a *comment* in `mcp.ts`). The agent-MCP **injection** lives on a
separate, unmerged umbrella (`feat/agent-orchestration` / `feat/agent-orch-provision`). The MCP server
itself runs in MAIN and the `canvas://boards` resource is fully live and reachable over loopback with a
token.

**Consequence:** the charter's "ask a live claude agent what it sees" eyeball is **not demonstrable on
this branch** — that depends on a cross-epic dependency. The faithful, equivalent proof S5 ships is an
**over-the-wire read of the actual `canvas://boards` resource** (real MCP client over loopback, same as
`e2e/mcp.e2e.ts`) showing the file path + fileRefs in the payload the agent would receive. When the
agent-orchestration injection later lands, a connected agent reads this same enriched resource with zero
further S5 work.

## What changes (app-side only)

| Layer | File | Change |
|---|---|---|
| Renderer mirror type | `renderer/src/store/boardStatus.ts` | `BoardMirrorEntry` += `path?: string`, `fileRefs?: {path,label}[]`; `buildBoardSnapshot` projects `path` for `type:'file'` and aggregates `fileRefs` from a planning board's `fileref` elements. |
| MAIN registry | `main/boardRegistry.ts` | `BoardMirror` += `path?`, `fileRefs?`; `sanitizeSnapshot` accepts/validates/caps both (string len ≤ `MAX_FIELD_LEN`; `fileRefs` bounded by a new `MAX_FILEREFS`). |
| Orchestrator projection | `main/mcpOrchestrator.ts` | `listBoardSummaries()` forwards `path` + `fileRefs` when present (conditional spread, same idiom as `agentKind`). A local `BoardSummary & {path?,fileRefs?}` widening keeps the package `BoardSummary` floor intact. |
| App self-model table | `main/appModel.ts` | Add the missing `'file'` row to `APP_BOARD_TYPES` (standing mirror-obligation — file type minted in S1, table never synced). `tools:['close_board']`, `states:['static']`, `seedable:false`, `autowire:null`. |

**No schema change** (S1 already minted `'file'` + `'fileref'`). **No package change.** **No new wire
resource.** The PTY-write path is untouched — we only enrich a READ projection.

## Tests

- `boardStatus.test.ts` (renderer) — file board → `path` in snapshot; planning board with fileref
  elements → aggregated `fileRefs`; terminal/browser snapshots byte-identical to before.
- `boardRegistry.test.ts` — `sanitizeSnapshot` keeps well-formed `path`/`fileRefs`, drops malformed,
  caps counts/lengths; forged/oversized payloads bounded.
- `mcpOrchestrator.test.ts` — `listBoards()` carries `path` + `fileRefs` through to the summary.
- `appModel.test.ts` — `'file'` appears in `boardTypes`.
- `e2e/fileMcpContext.e2e.ts` (`@file`/`@core`) — seed a real file board + a planning board with a
  fileref → wait for `useMcpPublish` → connect a real MCP client (`mcpInfo()`) → read `canvas://boards`
  → assert the file board's `path` and the planning board's `fileRefs` are present. Over-the-wire proof.

## Invariant audit (must hold)

- File-ref data flows ONLY through the read projection (`mirror → listBoards → canvas://boards`).
- `writeToPty` / the gated dispatch path is not touched; Browser-board content still never reaches the
  PTY. `path`/`fileRefs` are trusted-user input (the human dropped/opened them), never executed.
- Mirror is an IPC channel → every new field is sanitized + bounded in `sanitizeSnapshot`.
