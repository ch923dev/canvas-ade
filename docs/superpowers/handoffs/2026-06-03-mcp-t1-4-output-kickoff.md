# Kickoff brief — MCP roadmap T1.4: 🔒 `canvas://board/{id}/output` (capped + paginated)

- **Date:** 2026-06-03
- **Milestone/Task:** M1 (Observation) / **T1.4** (`docs/roadmap-mcp.md`)
- **Status:** ⏳ **NOT STARTED — this is a kickoff/scoping brief**, written after publishing the M0/M1
  pkg chain (v0.2.4). Security-tagged (🔒) + first card to touch `pty.ts` for real → scoped here for
  review before implementation.
- **Branches to cut:** app `feat/mcp-t1-4-output` off `feat/mcp-integration`; pkg `feat/board-output`
  off pkg `main` (now at `8bddc48`/v0.2.4, the held chain is merged + published).

## Card (roadmap)
> **app** — a read-only, **size-capped** scrollback accessor in `pty.ts` (never dump raw buffer).
> **pkg** — paginated resource honoring the **25k MCP output cap**; cap, don't truncate-blind.
> **e2e:** run a command emitting > cap bytes; assert paginated, capped, ordered output.
> **Manual:** Inspector pages through a long-running board's output.

## Key finding — the buffer ALREADY exists (don't build a new one)
`pty.ts` already keeps a **capped per-session ring buffer**:
- `RING_CAP_BYTES = 256 * 1024` (256 KB) — `src/main/pty.ts:58`.
- `appendRing(prev, chunk, cap)` (`:26`) keeps the **last `cap` bytes** (slices off the front).
- Fed by the single `proc.onData((d) => { buf.data = appendRing(buf.data, d, RING_CAP_BYTES) })`
  listener (`:464`). `buf` is a boxed `{ data: string }` that survives park/adopt (#15 replay).
- Read today at `:418` (`sessions.get(id)?.buf.data ?? parked.get(id)?.buf.data ?? ''`) for adopt-replay.
- **Content is RAW** PTY output — includes ANSI escape codes, partial lines, ConPTY soft-wraps.

So T1.4 = expose a **read-only, paged, capped slice** of this existing 256 KB ring — not a new buffer.

## Proposed shape (review these decisions before coding)

### app (`Z:\Canvas ADE`)
1. **`pty.ts` accessor** — `readPtyOutput(id, opts): { data, nextCursor, totalBytes, dropped }`.
   - Source: the session's (or parked session's) `buf.data`.
   - **Cap per call** at the MCP page size (see decision D2) — **never return the whole 256 KB in one
     call** (the 🔒 "never dump raw buffer" rule). Slice the tail/window, report `dropped` bytes when
     the ring has overwritten older output (be honest about truncation — no silent blind-truncate).
   - Read-only, control-plane only. Frame-guarded (it's reached via the orchestrator adapter in MAIN,
     not a renderer IPC — confirm no new renderer surface is opened).
2. **Orchestrator interface** (`@ch923dev/canvas-ade-mcp` `Orchestrator`) — add
   `boardOutput(id, cursor?): Promise<{ data; nextCursor?; dropped? }>`. Update `MockOrchestrator`.
   - **Cross-repo:** this is an interface change in the pkg → app adapter implements it. Bump pkg minor.
3. **`mcpOrchestrator.ts` adapter** — implement `boardOutput` by calling the `pty.ts` accessor; it
   currently throws for the write methods but `boardOutput` is a read → wire it to the registry.
   - The adapter's `BoardRegistry` (MAIN-owned) needs a new `readOutput(id, opts)` seam fed by
     `pty.ts` (mirror how `listSessions` is injected in `index.ts:166`).

### pkg (`Z:\canvas-ade-mcp`)
4. **`src/resources/output.ts`** — `canvas://board/{id}/output` templated resource (like
   `board-status`). Paginated: accept a cursor (query param or a `?cursor=` convention — check the SDK's
   templated-resource variable support; may need the cursor in the URI or a separate `read` arg).
   - **🔒 25k cap per page** (`MCP output cap`) — hard cap the returned text; surface `nextCursor` +
     a `dropped`/`truncated` flag so the agent knows to page, never a silent cut.
   - Both tiers (observation is safe). Contract + live tests.

## 🔒 Security checklist (do NOT skip — this is the first PTY-output exposure)
- **Never the raw unbounded buffer** — every read path is capped; 256 KB ring × 25k page.
- **Read-only** — no write/echo back to the PTY from this surface; Browser-board content never involved.
- **Honest truncation** — report `dropped`/`nextCursor`; never blind-truncate (roadmap: "cap, don't
  truncate-blind"). Log dropped bytes if a page boundary discards.
- **No new renderer IPC** — the accessor lives MAIN-side, reached via the orchestrator adapter only.
- Decide **ANSI handling** (D1) — raw ANSI is a control-sequence injection surface for whatever renders
  the agent's view; consider stripping escape codes server-side (or flag it).

## Open decisions (resolve at kickoff)
- **D1 — ANSI:** return raw `buf.data` (ANSI intact) or strip escape codes? Stripping is safer + more
  agent-useful, but loses fidelity. Recommend: **strip to plain text** for v1 (an agent wants the text,
  not the cursor moves); keep raw as a future opt-in. There's likely an existing strip util in the
  xterm/terminal code to reuse.
- **D2 — page size:** the MCP cap is 25k; the ring is 256 KB → up to ~11 pages. Confirm 25k = chars or
  bytes; pick one and document.
- **D3 — cursor model:** byte-offset into the ring is fragile (the ring shifts as new output appends →
  an offset can fall off the front). Prefer a **tail-anchored** cursor (e.g. "bytes from end" or a
  monotonic sequence) + a `dropped` count when the requested region has aged out. This is the trickiest
  part — design it before coding.
- **D4 — exited boards:** parked/exited sessions still hold `buf.data` (`:418`) → output remains
  readable after exit (good for `result`/post-mortem; aligns with T1.5). Confirm the lifetime.

## Test plan
- **pkg contract + live:** a mock orchestrator returns a >25k output; assert the resource caps each
  page, returns `nextCursor`, and paging reassembles ordered content; empty/absent board → empty.
- **app e2e (`mcpSmoke.ts`):** seed a terminal, run a command emitting > cap bytes (e.g. a big `seq`/
  loop), `fitView` (spawn), poll until output is readable, page through `canvas://board/{id}/output`,
  assert: capped per page, ordered, `dropped`/`nextCursor` behave. Self-activating skip until the new
  pkg version (`canvas://board/{id}/output`) is published (same pattern as T1.2/T1.3).
- Standing gates: app `typecheck/lint/format/test/build` + `CANVAS_SMOKE=mcp` (now expects
  `MCP_STATUS/STATES/ATTENTION/COMMAND_OK` + a new `MCP_OUTPUT_*`); pkg `test`+`test:live`.

## Context the next session needs
- **Publish is done:** pkg `main` = v0.2.4 (M0/M1 chain), app on `^0.2.4`, all M1 probes live-green
  (`MCP_STATUS/STATES/ATTENTION_OK`). The next held pkg version (T1.4) publishes when the user says so
  (`git tag vX.Y.Z` → CI). Memory `mcp-publish-gating`.
- **⚠️ Worktree node_modules is now its OWN** (de-junctioned from main this session to consume 0.2.4) —
  normal `pnpm install` works here now; no junction dance needed. Don't re-junction.
- **Cadence (unchanged):** sub-branch per task → squash-merge to umbrella; both repos; e2e probe +
  manual; handoff after. **Do not merge to `main`.** Coordination board: declare zones (`pty.ts` is
  shared-sensitive — note it).
- Prior handoffs: T1.1 `…-t1-1-status-buckets.md`, T1.2 `…-t1-2-board-states.md`,
  T1.3 `…-t1-3-attention.md`.
