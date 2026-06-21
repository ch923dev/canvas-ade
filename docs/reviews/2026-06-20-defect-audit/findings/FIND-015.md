# FIND-015 — Connected-tier MCP tokens are never revoked on board close — rows accrete in the in-memory TokenStore and stay valid until app restart (documented revoke-on-close contract unimplemented in host)

| | |
|---|---|
| **Severity** | Low |
| **Category** | security · resource leak |
| **Status** | CONFIRMED (independently re-verified) |
| **Primary location** | `src/main/mcp.ts:144-149` |
| **Discovery slice** | M-MCP-ORCH (run 2) |

## Summary
Every connected-tier mint adds a row to the in-memory TokenStore (mintBoardToken → store.mint, package index.d.ts:294/345) but nothing in MAIN ever calls tokens.revoke(): a grep of src/main shows zero revoke() call sites. Tokens are minted on every terminal spawn (spawn-time provisioner), every Sync-modal status read (orchestrationProvision.ts:60 mints just to read the port and discards the token — still stored), and every manual sync (orchestrationProvision.ts:79). They carry a board-lifetime expiry, so a token minted for a board that has since been closed/reaped remains VALID and usable for the rest of the process run, and the rows map grows unboundedly with user actions. Combined with finding #1 (token still on disk), a closed board's credential keeps authorizing connected-tier actions until app restart. Likely an accepted v1 tradeoff (the package documents 'in-memory, dies on restart'), but the no-revoke-on-close gap is a real authz-hygiene/leak.

## Trigger
Open the Orchestration Sync modal repeatedly and/or spawn+reap several agent terminals in one session → each action mints a fresh never-revoked connected token; a token minted for a board closed an hour ago still validates against the loopback server.

## Evidence / concrete faulty path (code-grounded)
Confirmed faulty path: (a) Grep `\.revoke\(` over Z:\Canvas ADE\src → "No matches found" (no revoke call site in MAIN). (b) Package contract requires it: node_modules/@expanse-ade/mcp/dist/index.d.ts:289 "...and revoked when it closes". (c) 1-year TTL means no natural in-session expiry: dist/index.js:1106 `var DEFAULT_TTL_SECONDS = 365 * 24 * 60 * 60;` + index.js:1109 `const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;`; mcp.ts:145 `token: mintBoardToken(tokens, { boardId, tier: 'connected' }).token` (no ttlSeconds). (d) Verifier only fails on absent row: index.js:38-39 `const row = store.get(token); if (!row) throw new InvalidTokenError("Unknown or revoked token");`. (e) Reachable shipped mint sites: src/main/index.ts:642 `makeOrchestrationSyncProvider({ ..., mintToken: mintTerminalToken })`; src/main/orchestrationProvision.ts:60 `port = mintTerminalToken(SYNC_PSEUDO_BOARD).port` (token discarded but already store.mint'd) and :79 `token = mintTerminalToken(SYNC_PSEUDO_BOARD)`. (f) closeBoard never revokes: src/main/mcpLifecycle.ts:214-228 drains PTY + `tracked.delete(boardId)` only. Repro: open the Orchestration Sync modal N times and/or spawn+close several agent terminals in one session → each action adds a never-revoked row to TokenStore.rows; a token minted for a board closed earlier still passes verifyAccessToken against the loopback /mcp endpoint for the rest of the process run.

## Verifier reasoning (why CONFIRMED; scope & severity)
Verified every claim against the actual code. (1) Zero revoke call sites: a Grep for `\.revoke\(` across all of src/ returns no matches, so MAIN never invokes tokens.revoke(). (2) The package's own TokenStore doc (node_modules/@expanse-ade/mcp/dist/index.d.ts:288-290) states tokens are "minted out-of-band when a board spawns AND revoked when it closes" — so revoke-on-close is the INTENDED contract, and the host leaves the revoke half unimplemented. (3) Tokens carry a ~board-lifetime expiry: mintBoardToken (index.js:1106-1114) defaults to DEFAULT_TTL_SECONDS = 365*24*60*60 (one year); mcp.ts:145 passes no ttlSeconds override, so a connected token's expiresAt never lapses within a session. The verifier (index.js:37-46) only rejects on a missing row ("Unknown or revoked token"); the sole in-session invalidation is an explicit revoke that never happens. (4) Both mint paths are wired into real shipped MAIN code, not just tests: index.ts:642 registers the spawn-time provisioner (mints a board-bound connected token per terminal spawn), and orchestrationProvision.ts:60/79 mint on every Sync-modal status read (mint-then-discard, still stored) and every manual sync. (5) closeBoard (mcpLifecycle.ts:214-228) drains the PTY and `tracked.delete(boardId)` but never touches the token store — exactly as the candidate claims. Net effect: tokens.rows grows unbounded with user actions and a closed board's credential stays valid until app restart. Severity stays Low: the server is loopback-only, origin-guarded, bearer-gated, and the raw token never crosses to the renderer for the Sync pseudo-board; no data loss / crash / cross-user exposure. It is a genuine authz-hygiene + slow in-memory-growth defect (a documented-contract gap), in scope as a correctness item, not a perf/a11y/styling/file-size audit class.

## Fix direction (audit only — NOT applied)
Revoke a board connected-tier token from the TokenStore on board close/delete (honor the documented revoke-on-close contract), or bound the store, so minted tokens do not accrete and stay valid until app restart.

## Files this card touches
- `src/main/mcp.ts (144-149)`
- `@expanse-ade/mcp TokenStore (host-side revoke call)`

## Collision flags (sequence with)
- token-lifecycle theme → FIND-001 (token persists on disk after revoke)
