# Handoff — MCP roadmap T0.2: Host-header allowlist + ADR

- **Date:** 2026-06-03
- **Milestone/Task:** M0 / **T0.2** (`docs/roadmap-mcp.md`)
- **Repo:** `Z:\canvas-ade-mcp` (the MCP package) — branch `feat/host-header-guard`, commit `c6e1b33`, **PR #1**.
- **Status:** ✅ done, gate-green, PR open for review. Not yet merged/published.

## What landed

The MANDATORY DNS-rebinding mitigation (closes audit **R2**). `hostGuard` is now the outer
middleware (`hostGuard → originGuard → requireBearerAuth`): allows only a loopback `Host`
(`localhost` / `127.0.0.1` / `::1`, ± `:port`, case-insensitive, bracketed-IPv6 `[::1]` handled),
else `403 { error: 'forbidden_host' }`. Missing `Host` is rejected (HTTP/1.1 always carries it),
unlike missing `Origin` (CLI clients omit it). Defence in depth with the existing Origin guard +
per-board bearer token.

**Why:** loopback bind + Origin alone are insufficient (TS-SDK CVE-2025-66414, fixed upstream in sdk
1.24.0). Expanse's vector = a Browser board previewing a malicious `localhost` page.

## Files
- `src/security/host.ts` — `hostGuard` + `isLoopbackHost`
- `src/server/mcpHttp.ts` — wired first in the pipeline
- `test/contract/hostGuard.contract.test.ts` — loopback set ±port, suffix-attack (`localhost.evil.com`) + cloud-metadata-IP rejection, middleware 403/next
- `test/live/hostGuard.live.test.ts` — raw `node:http` forges `Host`: spoof→403, loopback→401-not-403
- `docs/decisions/0003-host-header-guard.md` — ADR
- `package.json` — 0.2.0 → **0.2.1**

## Test evidence (the two-layer gate)
- **Contract:** 22 passed (was 17, +5 host).
- **Live:** 16 passed (+3 host: spoof 403, suffix-attack 403, loopback 401-not-403).
- typecheck · lint · build all clean.
- **Manual:** not run yet — the package has no in-process Inspector path; the manual forged-`Host`
  check is the **app-side follow-up** below (needs the published 0.2.1 consumed by Canvas ADE MAIN).

## Follow-ups (carried, not blockers)
1. **Merge PR #1 + publish v0.2.1** (package repo) — then Canvas ADE bumps the dep.
2. **App-side T0.2 finish:** once 0.2.1 is consumed, add a forged-`Host`→403 probe to
   `src/main/mcpSmoke.ts` (the live-against-Canvas-ADE half of the two-layer test) + the manual
   Inspector check. Small; do it when the bump lands.
3. The package working tree still has unrelated research WIP (`docs/research/mcp-swarm-research.md`
   modified, `mcp-client-connection-matrix.md` untracked) — left out of this commit on purpose.

## Next task
**T0.3 — MAIN→renderer command channel scaffold** (app repo, `feat/mcp-integration` umbrella). The
inverse of the `mcp:boards` mirror: a `mcp:command` channel MAIN→renderer with a no-op `ping` to prove
the round-trip; real board CRUD commands arrive in M3. See `docs/roadmap-mcp.md` § M0 / T0.3.

Parallel/independent: **T0.1** (land PR #32) is still gated on the GitHub **package read-access grant**
(user's manual step) for CI to go green.
